import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire'
import { describe, expect, it } from 'vitest'
import {
  decodeUserPostResponse,
  encodeUserPostRequest
} from '../../src/main/core/tieba-userpost-proto'

describe('贴吧客户端用户回复 Protobuf', () => {
  it('编码查询账号、页码、内容开关和本地登录凭据', () => {
    const bytes = encodeUserPostRequest({
      uid: '123456789',
      bduss: 'private-test-bduss',
      page: 7,
      pageSize: 30,
      clientVersion: '22.6.5.1'
    })
    const reader = new BinaryReader(bytes)
    expect(reader.uint32()).toBe(10)
    const dataEnd = reader.pos + reader.uint32()
    const values: Record<string, string | number> = {}
    while (reader.pos < dataEnd) {
      const tag = reader.uint32()
      if (tag >>> 3 === 1) values.uid = reader.uint64().toString()
      else if (tag >>> 3 === 2) values.pageSize = reader.uint32()
      else if (tag >>> 3 === 5) values.needContent = reader.uint32()
      else if (tag >>> 3 === 26) values.page = reader.uint32()
      else if (tag >>> 3 === 27) {
        const commonEnd = reader.pos + reader.uint32()
        while (reader.pos < commonEnd) {
          const commonTag = reader.uint32()
          if (commonTag >>> 3 === 2) values.clientVersion = reader.string()
          else if (commonTag >>> 3 === 10) values.bduss = reader.string()
          else reader.skip(commonTag & 7)
        }
      } else reader.skip(tag & 7)
    }

    expect(values).toEqual({
      uid: '123456789',
      pageSize: 30,
      needContent: 1,
      page: 7,
      clientVersion: '22.6.5.1',
      bduss: 'private-test-bduss'
    })
  })

  it('解码回复正文、时间、吧名、昵称和头像', () => {
    const writer = new BinaryWriter()
    const data = writer.uint32(18).fork()
    const group = data.uint32(10).fork()
    group.uint32(8).uint64('101')
    group.uint32(16).uint64('82001')
    group.uint32(24).uint64('82000')
    group.uint32(40).uint32(1_725_000_000)
    group.uint32(50).string('测试吧')
    group.uint32(58).string('原帖标题')
    group.uint32(82).string('account-name')
    group.uint32(154).string('tb.1.portrait')
    group.uint32(282).string('展示昵称')
    const content = group.uint32(66).fork()
    const text = content.uint32(10).fork()
    text.uint32(8).uint32(0)
    text.uint32(18).string('回复正文')
    text.join()
    content.uint32(16).uint64('1725000000')
    content.uint32(24).uint64('1')
    content.uint32(32).uint64('92001')
    content.join()
    group.join()
    data.join()

    expect(decodeUserPostResponse(writer.finish())).toEqual({
      errorCode: 0,
      errorMessage: '',
      hidden: false,
      groups: [
        {
          forumId: '101',
          threadId: '82001',
          postId: '82000',
          createTime: 1_725_000_000,
          forumName: '测试吧',
          title: '原帖标题',
          userName: 'account-name',
          userPortrait: 'tb.1.portrait',
          nameShow: '展示昵称',
          content: [
            {
              postContent: [{ type: 0, text: '回复正文' }],
              createTime: '1725000000',
              postType: '1',
              postId: '92001'
            }
          ]
        }
      ]
    })
  })

  it('不会把已删主题红点误判为整个回复源被隐藏', () => {
    const writer = new BinaryWriter()
    const data = writer.uint32(18).fork()
    data.uint32(64).int32(1)
    data.join()

    expect(decodeUserPostResponse(writer.finish())).toMatchObject({ hidden: false, groups: [] })
  })
})
