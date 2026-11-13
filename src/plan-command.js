// `/plan` lives in the channel, not in the agent prompt: typing "enter plan
// mode" as prose depends on the model doing the right thing, which is exactly
// the ambiguity this command removes. The actual switch is the host's
// `planMode` service, so the same rules apply as the desktop toggle.

/** Parse `/plan`, `/plan on|enter`, `/plan off|exit`, `/plan status`. */
export function parsePlanCommand(text) {
  const value = String(text ?? '')
    .trim()
    .toLowerCase()
  if (value === '/plan' || value === '/plan on' || value === '/plan enter') return 'enter'
  if (value === '/plan off' || value === '/plan exit') return 'exit'
  if (value === '/plan status') return 'status'
  return undefined
}

/**
 * Turn `planMode.set(...)`'s result into the reply the WeChat user sees.
 * The host reports what actually happened: `committed` (logged now),
 * `queued` (a turn is open, so it applies at the next in-turn pre-step),
 * `noop` (already there) and `cancelled` (an opposite pending switch was
 * cleared and the logged state already matches).
 */
export function describePlanSet(result, active) {
  switch (result) {
    case 'committed':
      return active
        ? '已进入计划模式：接下来这一轮只出方案，不会改文件。想退出就发 /plan off；提交计划后会在这里让你批准或打回。'
        : '已退出计划模式。'
    case 'queued':
      return active
        ? '已记录：当前这一轮跑完后进入计划模式。'
        : '已记录：当前这一轮跑完后退出计划模式。'
    case 'noop':
      return active ? '当前已经在计划模式。' : '当前不在计划模式。'
    case 'cancelled':
      return active
        ? '当前已经在计划模式（刚才的退出请求已取消）。'
        : '当前不在计划模式（刚才的进入请求已取消）。'
    default:
      return `计划模式切换返回了意外的结果：${String(result)}`
  }
}
