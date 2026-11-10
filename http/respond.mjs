/**
 * 插件路由的 HTTP 收口：写响应、读 JSON 请求体、判同源。
 *
 * 九个 handler 原先各抄一份写响应的代码，改一个响应头要改九处。这里只做传输，
 * 不判断任何业务字段。
 */

/** 请求体上限。配置补丁与 Key 都很短，超过这个长度不回。 */
const MAX_BODY_BYTES = 8192

/** 回一段 JSON。头与长度一起写，避免调用方漏掉 Content-Length。 */
export function send(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  res.end(text)
}

/** 回一个只有状态码的响应，不带响应体。 */
export function sendBare(res, code) {
  res.statusCode = code
  res.end()
}

/**
 * 读 JSON 请求体，校验通过后交给 onBody。
 *
 * 强制 `application/json`：插件路由不受宿主 auth fence 保护，浏览器里任意页面都能向
 * localhost 发 no-cors 的 text/plain POST。要求 JSON 类型会让跨站请求触发预检而失败，
 * 顺手挡掉配置被跨站改写的路径。
 */
export function collectJson(req, res, onBody) {
  const headers = req !== null && typeof req === 'object' && req.headers !== undefined ? req.headers : {}
  const contentType = String(headers['content-type'] ?? '').toLowerCase()
  if (!contentType.includes('application/json')) {
    send(res, 415, { error: 'content-type must be application/json' })
    return
  }
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) req.destroy()
  })
  req.on('end', () => {
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      send(res, 400, { error: 'body must be json' })
      return
    }
    if (body === null || typeof body !== 'object') {
      send(res, 400, { error: 'body must be a json object' })
      return
    }
    void onBody(body)
  })
}

/**
 * 同源检查：探活、写 Key、开文件这类动作只接受本页发起的请求。
 * 跨站页面即使能发 JSON，也过不了这一关；curl 之类不带这些头的不受影响。
 */
export function sameOrigin(req) {
  const headers = req !== null && typeof req === 'object' && req.headers !== undefined ? req.headers : {}
  const site = String(headers['sec-fetch-site'] ?? '')
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = String(headers.origin ?? '')
  if (origin === '') return true
  try {
    return new URL(origin).host === String(headers.host ?? '')
  } catch {
    return false
  }
}
