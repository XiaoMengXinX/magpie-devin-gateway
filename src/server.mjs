// One Devin account behind the OpenAI and Anthropic APIs, for one user with
// one key.
import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { pluginVersion } from "./devin.mjs"
import { fromMessages, RequestError, toMessages } from "./responses.mjs"

const openaiError = (status, message) => Response.json({ error: { message, type: "invalid_request_error", code: status } }, { status })
const anthropicError = (status, message) =>
  Response.json({ type: "error", error: { type: { 401: "authentication_error", 404: "not_found_error", 413: "request_too_large" }[status] ?? "invalid_request_error", message } }, { status })

// Devin answers a conversation that ends with the assistant's words as if the
// user had asked it to go on; a prefill is turned away instead.
const PREFILL = "the conversation must end with a user message or a tool result; assistant prefill is not supported"
const endsWithAssistant = (messages) => Array.isArray(messages) && messages[messages.length - 1]?.role === "assistant"

export function createGateway({ apiKey, devin }) {
  const digest = (s) => createHash("sha256").update(s).digest()
  const want = digest(apiKey)
  const authorized = (h) => {
    const bearer = /^Bearer (.+)$/.exec(h.authorization ?? "")?.[1]
    const key = bearer ?? h["x-api-key"]
    return typeof key === "string" && timingSafeEqual(digest(key), want)
  }

  const routes = {
    "/v1/chat/completions": {
      error: openaiError,
      handle: (body, signal) => (endsWithAssistant(body.messages) ? openaiError(400, PREFILL) : devin.chat(body, signal)),
    },
    "/v1/messages": {
      error: anthropicError,
      handle: (body, signal) => (endsWithAssistant(body.messages) ? anthropicError(400, PREFILL) : devin.messages(body, signal)),
    },
    "/v1/responses": {
      error: openaiError,
      async handle(body, signal) {
        const req = toMessages(body)
        if (endsWithAssistant(req.messages)) return openaiError(400, PREFILL)
        return fromMessages(await devin.messages(req, signal), body)
      },
    },
  }

  async function answer(req, signal) {
    const path = new URL(req.url, "http://gateway").pathname
    if (req.method === "GET" && path === "/health") return Response.json({ status: "ok", plugin: pluginVersion, devinKey: devin.signedIn })
    const route = routes[path]
    const error = route?.error ?? openaiError
    if (!authorized(req.headers)) return error(401, "invalid API key")
    if (req.method === "GET" && path === "/v1/models")
      return Response.json({ object: "list", data: (await devin.models()).map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "devin", display_name: m.name })) })
    if (req.method !== "POST" || !route) return error(404, `no route for ${req.method} ${path}`)
    if (!devin.signedIn) return error(401, "DEVIN_API_KEY is not set")
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      return error(400, "the request body is not JSON")
    }
    try {
      return await route.handle(body, signal)
    } catch (e) {
      if (e instanceof RequestError) return error(e.status, e.message)
      throw e
    }
  }

  return createServer(async (req, res) => {
    const ac = new AbortController()
    res.on("close", () => ac.abort())
    let reply
    try {
      reply = await answer(req, ac.signal)
    } catch (e) {
      if (ac.signal.aborted) return
      console.error(e)
      reply = openaiError(500, "internal error")
    }
    const headers = { "Content-Type": reply.headers.get("content-type") ?? "application/json" }
    if (reply.headers.get("cache-control")) headers["Cache-Control"] = reply.headers.get("cache-control")
    res.writeHead(reply.status, headers)
    if (!reply.body) return res.end()
    // a client that leaves cancels the reply, and the plugin's request to Devin with it
    await pipeline(Readable.fromWeb(reply.body), res).catch(() => {})
  })
}

