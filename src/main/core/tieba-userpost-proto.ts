import { BinaryReader, BinaryWriter } from '@bufbuild/protobuf/wire'

export interface UserPostProtoText {
  type: number
  text: string
}

export interface UserPostProtoContent {
  postContent: UserPostProtoText[]
  createTime: string
  postType: string
  postId: string
}

export interface UserPostProtoGroup {
  forumId: string
  threadId: string
  postId: string
  createTime: number
  forumName: string
  title: string
  content: UserPostProtoContent[]
  userName: string
  userPortrait: string
  nameShow: string
}

export interface UserPostProtoResponse {
  errorCode: number
  errorMessage: string
  groups: UserPostProtoGroup[]
  hidden: boolean
}

export interface UserPostProtoRequest {
  uid: string
  bduss?: string
  page: number
  pageSize: number
  clientVersion: string
}

/** Encodes the small subset of UserPostReqIdl required by Tieba's user-post feed. */
export function encodeUserPostRequest(input: UserPostProtoRequest): Uint8Array {
  const writer = new BinaryWriter()
  const data = writer.uint32(10).fork()
  data.uint32(8).uint64(input.uid)
  data.uint32(16).uint32(input.pageSize)
  data.uint32(40).uint32(1)
  data.uint32(208).uint32(input.page)
  const common = data.uint32(218).fork()
  common.uint32(18).string(input.clientVersion)
  if (input.bduss) common.uint32(82).string(input.bduss)
  common.join()
  data.join()
  return writer.finish()
}

/** Decodes only the fields used by the cleanup preview and safely skips the rest. */
export function decodeUserPostResponse(bytes: Uint8Array): UserPostProtoResponse {
  const reader = new BinaryReader(bytes)
  let errorCode = 0
  let errorMessage = ''
  let hidden = false
  const groups: UserPostProtoGroup[] = []

  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    switch (tag >>> 3) {
      case 1: {
        if ((tag & 7) !== 2) break
        const error = readError(reader, readEnd(reader))
        errorCode = error.code
        errorMessage = error.message
        continue
      }
      case 2: {
        if ((tag & 7) !== 2) break
        const data = readData(reader, readEnd(reader))
        groups.push(...data.groups)
        hidden ||= data.hidden
        continue
      }
    }
    reader.skip(tag & 7)
  }

  return { errorCode, errorMessage, groups, hidden }
}

function readData(
  reader: BinaryReader,
  end: number
): { groups: UserPostProtoGroup[]; hidden: boolean } {
  const groups: UserPostProtoGroup[] = []
  let hidden = false
  while (reader.pos < end) {
    const tag = reader.uint32()
    switch (tag >>> 3) {
      case 1:
        if ((tag & 7) === 2) {
          groups.push(readGroup(reader, readEnd(reader)))
          continue
        }
        break
      case 2:
      case 6:
        if ((tag & 7) === 0) {
          hidden ||= reader.int32() !== 0
          continue
        }
        break
    }
    reader.skip(tag & 7)
  }
  return { groups, hidden }
}

function readError(reader: BinaryReader, end: number): { code: number; message: string } {
  let code = 0
  let message = ''
  while (reader.pos < end) {
    const tag = reader.uint32()
    if (tag >>> 3 === 1 && (tag & 7) === 0) {
      code = reader.int32()
      continue
    }
    if ([2, 3].includes(tag >>> 3) && (tag & 7) === 2) {
      const value = reader.string()
      if (!message) message = value
      continue
    }
    reader.skip(tag & 7)
  }
  return { code, message }
}

function readGroup(reader: BinaryReader, end: number): UserPostProtoGroup {
  const group: UserPostProtoGroup = {
    forumId: '0',
    threadId: '0',
    postId: '0',
    createTime: 0,
    forumName: '',
    title: '',
    content: [],
    userName: '',
    userPortrait: '',
    nameShow: ''
  }
  while (reader.pos < end) {
    const tag = reader.uint32()
    switch (tag >>> 3) {
      case 1:
        if ((tag & 7) === 0) {
          group.forumId = reader.uint64().toString()
          continue
        }
        break
      case 2:
        if ((tag & 7) === 0) {
          group.threadId = reader.uint64().toString()
          continue
        }
        break
      case 3:
        if ((tag & 7) === 0) {
          group.postId = reader.uint64().toString()
          continue
        }
        break
      case 5:
        if ((tag & 7) === 0) {
          group.createTime = reader.uint32()
          continue
        }
        break
      case 6:
        if ((tag & 7) === 2) {
          group.forumName = reader.string()
          continue
        }
        break
      case 7:
        if ((tag & 7) === 2) {
          group.title = reader.string()
          continue
        }
        break
      case 8:
        if ((tag & 7) === 2) {
          group.content.push(readContent(reader, readEnd(reader)))
          continue
        }
        break
      case 10:
        if ((tag & 7) === 2) {
          group.userName = reader.string()
          continue
        }
        break
      case 19:
        if ((tag & 7) === 2) {
          group.userPortrait = reader.string()
          continue
        }
        break
      case 35:
        if ((tag & 7) === 2) {
          group.nameShow = reader.string()
          continue
        }
        break
    }
    reader.skip(tag & 7)
  }
  return group
}

function readContent(reader: BinaryReader, end: number): UserPostProtoContent {
  const content: UserPostProtoContent = {
    postContent: [],
    createTime: '0',
    postType: '0',
    postId: '0'
  }
  while (reader.pos < end) {
    const tag = reader.uint32()
    switch (tag >>> 3) {
      case 1:
        if ((tag & 7) === 2) {
          content.postContent.push(readText(reader, readEnd(reader)))
          continue
        }
        break
      case 2:
        if ((tag & 7) === 0) {
          content.createTime = reader.uint64().toString()
          continue
        }
        break
      case 3:
        if ((tag & 7) === 0) {
          content.postType = reader.uint64().toString()
          continue
        }
        break
      case 4:
        if ((tag & 7) === 0) {
          content.postId = reader.uint64().toString()
          continue
        }
        break
    }
    reader.skip(tag & 7)
  }
  return content
}

function readText(reader: BinaryReader, end: number): UserPostProtoText {
  const content: UserPostProtoText = { type: 0, text: '' }
  while (reader.pos < end) {
    const tag = reader.uint32()
    if (tag >>> 3 === 1 && (tag & 7) === 0) {
      content.type = reader.uint32()
      continue
    }
    if (tag >>> 3 === 2 && (tag & 7) === 2) {
      content.text = reader.string()
      continue
    }
    reader.skip(tag & 7)
  }
  return content
}

function readEnd(reader: BinaryReader): number {
  const length = reader.uint32()
  return reader.pos + length
}
