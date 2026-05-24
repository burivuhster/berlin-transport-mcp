import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const VBB_API_BASE = "https://v6.vbb.transport.rest";

type AuthEnv = Env & { MCP_API_KEY?: string; MCPAL_VERIFICATION?: string };

function tokensMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

function requireAuth(request: Request, env: AuthEnv): Response | null {
	if (!env.MCP_API_KEY) {
		return new Response("Server misconfigured: MCP_API_KEY is not set", {
			status: 500,
		});
	}
	if (!env.MCPAL_VERIFICATION) {
		return new Response("Server misconfigured: MCPAL_VERIFICATION is not set", {
			status: 500,
		});
	}
	const header = request.headers.get("Authorization") ?? "";
	const prefix = "Bearer ";
	if (!header.startsWith(prefix) || !tokensMatch(header.slice(prefix.length), env.MCP_API_KEY)) {
		return new Response("Unauthorized", {
			status: 401,
			headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
		});
	}
	return null;
}

function withInboundSecret(response: Response, env: AuthEnv): Response {
	const headers = new Headers(response.headers);
	if (env.MCPAL_VERIFICATION) {
		headers.set("x-mcpal-inbound-secret", env.MCPAL_VERIFICATION);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Define our MCP agent with tools
export class BerlinTransportMCP extends McpAgent {
	server = new McpServer({
		name: "Berlin Transport API",
		version: "1.0.0",
	});

	async init() {
		// Search for stops
		this.server.registerTool(
			"search_stops",
			{
				inputSchema: {
					query: z.string().describe("Search query for stops"),
				},
				annotations: {
					title: "Search Stops",
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: true,
				},
			},
			async ({ query }) => {
				const url = new URL("/locations", VBB_API_BASE);
				url.searchParams.set("query", query);
				url.searchParams.set("poi", "false");
				url.searchParams.set("addresses", "false");

				const response = await fetch(url);
				const data = await response.json();
				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// Get departures for a stop
		this.server.registerTool(
			"get_departures",
			{
				inputSchema: {
					stop_id: z.string().describe("Stop ID to get departures for"),
					results: z.number().optional().describe("Number of results to return"),
				},
				annotations: {
					title: "Get Departures",
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: true,
				},
			},
			async ({ stop_id, results }) => {
				const url = new URL(`/stops/${stop_id}/departures`, VBB_API_BASE);
				if (results) {
					url.searchParams.set("results", String(results));
				}

				const response = await fetch(url);
				const data = await response.json();
				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);

		// Get journeys from A to B
		this.server.registerTool(
			"get_journeys",
			{
				inputSchema: {
					from: z.string().describe("Origin stop ID"),
					to: z.string().describe("Destination stop ID"),
					departure: z.string().optional().describe("Departure time (e.g. tomorrow 2pm)"),
					results: z.number().optional().describe("Number of results to return"),
				},
				annotations: {
					title: "Get Journeys",
					readOnlyHint: true,
					idempotentHint: true,
					openWorldHint: true,
				},
			},
			async ({ from, to, departure, results }) => {
				const url = new URL("/journeys", VBB_API_BASE);
				url.searchParams.set("from", from);
				url.searchParams.set("to", to);
				if (departure) {
					url.searchParams.set("departure", departure);
				}
				if (results) {
					url.searchParams.set("results", String(results));
				}

				const response = await fetch(url);
				const data = await response.json();
				return {
					content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				};
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const authEnv = env as AuthEnv;
		const authError = requireAuth(request, authEnv);
		if (authError) return withInboundSecret(authError, authEnv);

		const url = new URL(request.url);
		let response: Response;

		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			response = await BerlinTransportMCP.serve("/mcp", {
				transport: "auto",
			}).fetch(request, env, ctx);
		} else if (url.pathname === "/sse" || url.pathname.startsWith("/sse/")) {
			response = await BerlinTransportMCP.serveSSE("/sse").fetch(request, env, ctx);
		} else {
			response = new Response("Not found", { status: 404 });
		}

		return withInboundSecret(response, authEnv);
	},
};
