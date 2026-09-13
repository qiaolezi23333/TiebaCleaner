import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const projectRoot = new URL('..', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1')
const dialogImage = join(projectRoot, 'build', 'installer-dialog.png')
const bannerImage = join(projectRoot, 'build', 'installer-banner.png')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- This hook must stay executable JavaScript for electron-builder.
function escapeXmlAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * @param {string} projectPath
 * @returns {Promise<void>}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- This hook must stay executable JavaScript for electron-builder.
export default async function patchMsiProject(projectPath) {
  const projectFile = projectPath.endsWith('.wxs') ? projectPath : join(projectPath, 'project.wxs')
  const source = await readFile(projectFile, 'utf8')

  const replacements = [
    ['Language="1033" Codepage="65001"', 'Language="2052" Codepage="936"'],
    [
      '<WixVariable Id="WixUISupportPerMachine" Value="1" Overridable="yes"/>',
      `<WixVariable Id="WixUISupportPerMachine" Value="1" Overridable="yes"/>
      <WixVariable Id="WixUIDialogBmp" Value="${escapeXmlAttribute(dialogImage)}"/>
      <WixVariable Id="WixUIBannerBmp" Value="${escapeXmlAttribute(bannerImage)}"/>`
    ],
    // VersionNT can be compatibility-shimmed. Read the real Windows build from
    // HKLM and keep a native MSI launch condition for Windows 10/11.
    [
      '<Condition Message="Windows 7 and above is required"><![CDATA[Installed OR VersionNT >= 601]]></Condition>',
      `<Property Id="WINDOWS_BUILD_NUMBER">
      <RegistrySearch Id="WindowsBuildNumberSearch"
                      Root="HKLM"
                      Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
                      Name="CurrentBuildNumber"
                      Type="raw"
                      Win64="yes" />
    </Property>
    <Condition Message="需要 Windows 10 或更高版本"><![CDATA[Installed OR (WINDOWS_BUILD_NUMBER AND WINDOWS_BUILD_NUMBER >= 10240)]]></Condition>`
    ],
    [
      '<Publish Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="VerifyReadyDlg" Order="6">WixAppFolder = "WixPerUserFolder"</Publish>',
      '<Publish Dialog="InstallScopeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="6">WixAppFolder = "WixPerUserFolder"</Publish>'
    ],
    [
      '<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Run 贴吧清理助手"/>',
      '<Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="安装完成后启动贴吧清理助手"/>'
    ],
    [
      '<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">',
      `<ComponentGroup Id="ProductComponents" Directory="APPLICATIONFOLDER">
      <Component Id="AppUninstallRegistration" Guid="*" Win64="yes">
        <RegistryValue Root="HKMU" Key="Software\\TiebaCleaner" Name="ProductCode" Type="string" Value="[ProductCode]" KeyPath="yes"/>
        <RegistryValue Root="HKMU" Key="Software\\TiebaCleaner" Name="Version" Type="string" Value="[ProductVersion]"/>
        <RegistryValue Root="HKMU" Key="Software\\TiebaCleaner" Name="InstallLocation" Type="string" Value="[APPLICATIONFOLDER]"/>
      </Component>`
    ]
  ]

  let patched = source
  for (const [expected, replacement] of replacements) {
    if (!patched.includes(expected)) {
      throw new Error(`Generated MSI project is missing expected template text: ${expected}`)
    }
    patched = patched.replace(expected, replacement)
  }

  await writeFile(projectFile, patched, 'utf8')
}
