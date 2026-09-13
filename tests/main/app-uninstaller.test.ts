import { describe, expect, it } from 'vitest'
import { findMsiRegistration, parseMsiRegistrations } from '../../src/main/app-uninstaller'

const machineCode = '{EA02C474-F98B-4EE0-A2F6-F5A97B2B34CF}'
const userCode = '{11111111-2222-4333-8444-555555555555}'

describe('MSI 安装信息定位', () => {
  it('只接受合法产品代码并去重', () => {
    const result = parseMsiRegistrations(
      `${machineCode}\t2.1.9.0\tC:\\Program Files\\TiebaCleaner\ninvalid\t2.1.9\tC:\\Bad\n${machineCode.toLowerCase()}\t2.1.9.0\tC:\\Program Files\\TiebaCleaner`
    )

    expect(result).toEqual([
      {
        productCode: machineCode,
        version: '2.1.9.0',
        installLocation: 'C:\\Program Files\\TiebaCleaner'
      }
    ])
  })

  it('优先选择与当前程序目录一致的安装记录', async () => {
    const result = await findMsiRegistration(
      '2.1.9',
      'D:\\Apps\\TiebaCleaner\\TiebaCleaner.exe',
      async () =>
        `${machineCode}\t2.1.9.0\tC:\\Program Files\\TiebaCleaner\n${userCode}\t2.1.9.0\tD:\\Apps\\TiebaCleaner`
    )

    expect(result?.productCode).toBe(userCode)
  })

  it('旧安装记录没有目录时按应用版本选择', async () => {
    const result = await findMsiRegistration('2.1.9', 'C:\\App\\TiebaCleaner.exe', async () =>
      Promise.resolve(`${machineCode}\t2.1.8.0\t\n${userCode}\t2.1.9.0\t`)
    )

    expect(result?.productCode).toBe(userCode)
  })

  it('不会从未安装的开发版本误卸载其他版本', async () => {
    const result = await findMsiRegistration(
      '9.9.9',
      'C:\\Source\\TiebaCleaner.exe',
      async () => `${machineCode}\t2.1.8.0\t`
    )

    expect(result).toBeNull()
  })
})
