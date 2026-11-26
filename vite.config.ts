import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const MAX_BODY_BYTES = 2 * 1024 * 1024

function localApiSyncPlugin(): Plugin {
  return {
    name: 'local-api-sync',
    configureServer(server) {
      server.middlewares.use('/api/sync', async (req, res, next) => {
        try {
          let raw = ''
          if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
            raw = await new Promise<string>((resolve, reject) => {
              let size = 0
              let data = ''
              req.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_BODY_BYTES) {
                  reject(new Error('Payload too large'))
                  req.destroy()
                  return
                }
                data += chunk.toString('utf8')
              })
              req.on('end', () => resolve(data))
              req.on('error', reject)
            })
          }

          let parsedBody: unknown
          if (raw) {
            try {
              parsedBody = JSON.parse(raw)
            } catch {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'JSON tidak valid' }))
              return
            }
          }

          const apiReq = Object.assign(req, { body: parsedBody })

          const apiRes = Object.assign(res, {
            status(code: number) {
              res.statusCode = code
              return apiRes
            },
            json(payload: unknown) {
              if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json')
              }
              res.end(JSON.stringify(payload))
              return apiRes
            },
          })

          const modUrl = pathToFileURL(path.resolve(process.cwd(), 'api/sync.js')).href
          const { default: handler } = (await import(/* @vite-ignore */ modUrl)) as {
            default: (q: typeof apiReq, s: typeof apiRes) => Promise<void>
          }
          await handler(apiReq, apiRes)
        } catch (err) {
          next(err)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load all .env vars into Node process.env for local /api/sync middleware
  const allEnv = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(allEnv)) {
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }

  const env = loadEnv(mode, process.cwd(), ['VITE_', 'NEXT_PUBLIC_'])
  const processEnvDefines: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    processEnvDefines[`process.env.${key}`] = JSON.stringify(value)
  }

  return {
    plugins: [localApiSyncPlugin()],
    envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
    define: processEnvDefines,
  }
})
