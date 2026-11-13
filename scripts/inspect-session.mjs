import fs from 'node:fs'

const lines = fs.readFileSync('scripts/session.jsonl', 'utf8').split(/\r?\n/).filter(Boolean)
console.log('events', lines.length)
const keep = []
for (const line of lines) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    continue
  }
  if (/(?:approval|user\/message|turn\/end|assistant\/message|tool\/call)/.test(event.type ?? '')) keep.push(event)
}
const textOf = (event) => {
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => block.text ?? ('[' + block.type + ']')).join(' ').slice(0, 90)
}
for (const event of keep.slice(-40)) {
  const data = event.data ?? {}
  let extra = ''
  if (event.type === 'approval/asked') extra = ' tool=' + data.toolName + ' id=' + data.id + ' reason=' + String(data.reason ?? '').slice(0, 50)
  else if (event.type === 'approval/decided') extra = ' id=' + data.id + ' outcome=' + data.outcome
  else if (event.type === 'tool/call') extra = ' ' + data.name
  else if (event.type === 'user/message') extra = ' ' + textOf(event)
  else if (event.type === 'assistant/message') extra = ' ' + textOf(event)
  console.log(event.seq, event.type, extra)
}
