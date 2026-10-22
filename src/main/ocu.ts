import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Open Computer Use (MIT, github.com/iFurySt/open-computer-use): an open-source re-implementation of the tool surface of
 * OpenAI's Codex Computer Use — `list_apps`, `get_app_state` (indexed accessibility tree), then actions by
 * `element_index`. On Windows it drives apps through UI Automation / HWND messages, so it works on background windows
 * without stealing focus or the cursor.
 *
 * Jarvis runs it as a child MCP server and re-exports its tools through its own MCP server, so consent, the glowing
 * screen, the kill switch, the loop guard and cancellation apply to every call.
 */
export class Ocu {
  private client: Client | null = null
  private starting: Promise<Client> | null = null
  private idle: NodeJS.Timeout | null = null

  static binary(): string {
    const rel = join('node_modules', 'open-computer-use', 'dist', 'windows', process.arch === 'arm64' ? 'arm64' : 'amd64', 'open-computer-use.exe')
    const roots = app.isPackaged ? [join(process.resourcesPath, 'app.asar.unpacked'), process.resourcesPath] : [app.getAppPath()]
    for (const r of roots) {
      const p = join(r, rel)
      if (existsSync(p)) return p
    }
    return ''
  }

  static skillDir(): string {
    const rel = join('node_modules', 'open-computer-use', 'skills', 'open-computer-use')
    const roots = app.isPackaged ? [join(process.resourcesPath, 'app.asar.unpacked'), process.resourcesPath] : [app.getAppPath()]
    for (const r of roots) {
      const p = join(r, rel)
      if (existsSync(p)) return p
    }
    return ''
  }

  get available() {
    return !!Ocu.binary()
  }

  private async connect(): Promise<Client> {
    const bin = Ocu.binary()
    if (!bin) throw new Error('open-computer-use is not installed')
    const transport = new StdioClientTransport({ command: bin, args: ['mcp'], stderr: 'ignore' })
    const client = new Client({ name: 'jarvis', version: '1.0.0' }, { capabilities: {} })
    transport.onclose = () => {
      if (this.client === client) this.client = null
    }
    await client.connect(transport)
    return client
  }

  private async ensure(): Promise<Client> {
    if (this.idle) clearTimeout(this.idle)
    // a native automation server idles at ~60 MB: stop it when unused, it restarts on demand
    this.idle = setTimeout(() => void this.stop(), 180_000)
    if (this.client) return this.client
    if (!this.starting) {
      this.starting = this.connect()
        .then((c) => (this.client = c))
        .finally(() => (this.starting = null))
    }
    return this.starting
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 45_000): Promise<{ text: string; image?: { data: string; mimeType: string }; isError: boolean }> {
    const c = await this.ensure()
    const res: any = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
    let text = ''
    let image: { data: string; mimeType: string } | undefined
    for (const part of res.content ?? []) {
      if (part.type === 'text') text += (text ? '\n' : '') + part.text
      else if (part.type === 'image' && !image) image = { data: part.data, mimeType: part.mimeType }
    }
    return { text, image, isError: !!res.isError }
  }

  async stop() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const c = this.client
    this.client = null
    try {
      await c?.close()
    } catch {}
  }
}
