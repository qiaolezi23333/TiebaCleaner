import { createHash } from 'node:crypto'

const CLIENT_SECRET = 'tiebaclient!!!'

export function signClientParams(params: Readonly<Record<string, string>>): string {
  const raw =
    Object.keys(params)
      .filter((key) => key !== 'sign')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('') + CLIENT_SECRET
  return createHash('md5').update(raw).digest('hex')
}
