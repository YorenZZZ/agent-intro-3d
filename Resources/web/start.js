window.ClaudeIntro.prepare().catch(error => {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.intro
  if (handler) handler.postMessage(`error: ${error && error.message ? error.message : error}`)
})
