import { describe, expect, it } from 'vitest'
import type { CleanupItem, CleanupKind } from '../../src/shared/types'
import { completedItemMessage, failedItemMessage } from '../../src/main/core/task-target'

function item(kind: CleanupKind, overrides: Partial<CleanupItem> = {}): CleanupItem {
  return {
    id: `${kind}:1`,
    kind,
    title: '目标名称',
    summary: '',
    timestamp: null,
    timeLabel: null,
    timeKnown: false,
    sourceUrl: 'https://tieba.baidu.com/',
    status: 'pending',
    ...overrides
  }
}

describe('任务目标文案', () => {
  it.each([
    ['reply', item('reply', { title: '这是一条评论' }), '已删除评论“这是一条评论”'],
    ['post', item('post', { title: '主题标题' }), '已删除主题帖“主题标题”'],
    ['followingUser', item('followingUser', { displayName: '用户甲' }), '已取消关注用户“用户甲”'],
    ['followingForum', item('followingForum', { forumName: '测试吧' }), '已取消关注贴吧“测试吧”'],
    ['follower', item('follower', { displayName: '粉丝甲' }), '已移除粉丝“粉丝甲”']
  ] as const)('%s 成功记录包含具体目标', (_kind, target, expected) => {
    expect(completedItemMessage(target)).toBe(expected)
  })

  it('压缩空白并省略过长目标，失败记录包含原因', () => {
    const target = item('reply', { title: `第一行\n${'很长'.repeat(30)}` })
    const message = failedItemMessage(target, '平台拒绝操作')

    expect(message).toMatch(/^删除评论“第一行 很长/u)
    expect(message).toContain('…”失败：平台拒绝操作')
    expect(Array.from(message.match(/“(.+)”失败/u)?.[1] || '')).toHaveLength(32)
  })
})
