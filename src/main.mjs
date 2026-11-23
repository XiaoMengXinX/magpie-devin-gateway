import { createDevin, pluginVersion } from "./devin.mjs"
import { createGateway } from "./server.mjs"

const apiKey = process.env.GATEWAY_API_KEY
if (!apiKey) throw new Error("GATEWAY_API_KEY is required")
const devin = await createDevin(process.env.DEVIN_API_KEY)
const port = Number(process.env.PORT || 8790)
createGateway({ apiKey, devin }).listen(port, () => console.log(`magpie-devin-gateway listening on :${port}, plugin ${pluginVersion}, Devin key ${devin.signedIn ? "set" : "missing"}`))
