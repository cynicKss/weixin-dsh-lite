import assert from 'node:assert/strict'
import test from 'node:test'
import { describePlanSet, parsePlanCommand } from '../src/plan-command.js'

test('parsePlanCommand understands the explicit switches', () => {
  assert.equal(parsePlanCommand('/plan'), 'enter')
  assert.equal(parsePlanCommand(' /PLAN '), 'enter')
  assert.equal(parsePlanCommand('/plan on'), 'enter')
  assert.equal(parsePlanCommand('/plan enter'), 'enter')
  assert.equal(parsePlanCommand('/plan off'), 'exit')
  assert.equal(parsePlanCommand('/plan exit'), 'exit')
  assert.equal(parsePlanCommand('/plan status'), 'status')
})

test('parsePlanCommand leaves prose and other commands alone', () => {
  assert.equal(parsePlanCommand('进入计划模式'), undefined)
  assert.equal(parsePlanCommand('计划模式'), undefined)
  assert.equal(parsePlanCommand('/plans'), undefined)
  assert.equal(parsePlanCommand('/plan something'), undefined)
  assert.equal(parsePlanCommand(''), undefined)
  assert.equal(parsePlanCommand(undefined), undefined)
})

test('describePlanSet explains committed switches', () => {
  assert.match(describePlanSet('committed', true), /已进入计划模式/)
  assert.match(describePlanSet('committed', false), /已退出计划模式/)
})

test('describePlanSet explains queued switches', () => {
  assert.match(describePlanSet('queued', true), /跑完后进入计划模式/)
  assert.match(describePlanSet('queued', false), /跑完后退出计划模式/)
})

test('describePlanSet explains no-op switches', () => {
  assert.match(describePlanSet('noop', true), /已经在计划模式/)
  assert.match(describePlanSet('noop', false), /不在计划模式/)
})

test('describePlanSet explains cancelled pending switches', () => {
  assert.match(describePlanSet('cancelled', true), /已经在计划模式/)
  assert.match(describePlanSet('cancelled', false), /不在计划模式/)
})

test('describePlanSet never hides an unknown result', () => {
  assert.match(describePlanSet('weird', true), /意外的结果：weird/)
})
