const observabilityMessage = {
  date: new Date(0).toISOString(),
  args: [
    'File-backed logs are unavailable on Cloudflare Workers. Use Workers Logs / Observability in the Cloudflare dashboard or `wrangler tail`.',
  ],
  type: 'info',
  level: 3,
  tag: 'cframe/observability',
}

export default defineEventHandler(async (event) => {
  await requireAdminSession(event)

  setHeader(event, 'Cache-Control', 'no-store')

  if (getHeader(event, 'accept')?.includes('text/event-stream')) {
    return new Response(
      `retry: 60000\ndata: ${JSON.stringify({
        ...observabilityMessage,
        date: new Date().toISOString(),
      })}\n\n`,
      {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  return {
    source: 'cloudflare-workers-observability',
    available: false,
    message: observabilityMessage.args[0],
  }
})
