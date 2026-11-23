// The magpie devin plugin, unchanged, as one account: its loader's fetch
// answers chat completions and Messages requests itself, and its model hooks
// give the account's list.
import { DevinAuthPlugin } from "../upstream/packages/devin/index.mjs"
import pkg from "../upstream/packages/devin/package.json" with { type: "json" }

// The loader's fetch picks the API by the URL's path and never sends to it.
const ORIGIN = "http://devin.plugin"

export const pluginVersion = pkg.version

export async function createDevin(key) {
  const hooks = await DevinAuthPlugin()
  const auth = key ? { type: "api", key } : undefined
  // the loader gives no fetch without a key
  const { fetch: send } = await hooks.auth.loader(async () => auth)
  const config = {}
  await hooks.config(config)
  const provider = config.provider.devin
  const call = (path) => (body, signal) => send(ORIGIN + path, { method: "POST", body: JSON.stringify(body), signal })

  return {
    signedIn: !!send,
    chat: call("/v1/chat/completions"),
    messages: call("/v1/messages"),
    async models() {
      return Object.values(await hooks.provider.models(provider, { auth }))
    },
  }
}
