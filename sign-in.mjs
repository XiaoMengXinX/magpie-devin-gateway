// Signs in to Devin with the plugin's own browser sign-in (PKCE through
// app.devin.ai, its callback on 127.0.0.1) and stores the token as
// DEVIN_API_KEY, without printing it.
//
//   node sign-in.mjs                      write ./.env
//   node sign-in.mjs user@host /srv/dir   write /srv/dir/.env over ssh and recreate the container there
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { DevinAuthPlugin } from "./upstream/packages/devin/index.mjs"

const [target, dir] = process.argv.slice(2)
if (target && !dir) throw new Error("usage: node sign-in.mjs [user@host /path/to/gateway]")

const hooks = await DevinAuthPlugin()
const browser = hooks.auth.methods.find((m) => m.label === "Devin (browser)")
const { url, callback } = await browser.authorize()
console.log("Open this URL to sign in:\n" + url)
spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [url], { stdio: "ignore" }).on("error", () => {})
const r = await callback()
if (r.type !== "success") throw new Error("sign-in failed: " + r.error)
console.log("signed in:", r.metadata.email, r.metadata.plan ?? "")

if (!target) {
  let text = ""
  try {
    text = readFileSync(".env", "utf8")
  } catch {}
  const lines = text.split("\n").filter((l) => l && !l.startsWith("DEVIN_API_KEY="))
  writeFileSync(".env", [...lines, "DEVIN_API_KEY=" + r.key].join("\n") + "\n", { mode: 0o600 })
  console.log("DEVIN_API_KEY written to ./.env; restart the gateway to use it")
  process.exit(0)
}

// The remote side reads the token from stdin, so it never appears in a command line.
const update = `cd '${dir.replace(/'/g, "'\\''")}' && node -e '
const fs = require("fs")
let key = ""
process.stdin.on("data", (d) => (key += d)).on("end", () => {
  let text = ""
  try { text = fs.readFileSync(".env", "utf8") } catch {}
  const lines = text.split("\\n").filter((l) => l && !l.startsWith("DEVIN_API_KEY="))
  fs.writeFileSync(".env", [...lines, "DEVIN_API_KEY=" + key.trim()].join("\\n") + "\\n", { mode: 0o600 })
})' && chmod 600 .env && docker compose up -d --wait`
const ssh = spawn("ssh", [target, update], { stdio: ["pipe", "inherit", "inherit"] })
ssh.stdin.end(r.key)
ssh.on("exit", (code) => process.exit(code ?? 1))
