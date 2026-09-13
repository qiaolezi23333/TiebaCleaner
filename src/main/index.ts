import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { AppSettings, UninstallDataMode } from '../shared/types'
import { AccountSessionManager } from './account-manager'
import { findMsiRegistration, launchMsiUninstaller } from './app-uninstaller'
import { CoreEngine } from './core/engine'
import { CoreError } from './core/errors'
import { ElectronSessionTransport } from './electron-transport'
import { createCoreLogger, registerIpcHandlers } from './ipc'
import { SettingsStore, TaskLogStore } from './storage'

let disposeIpc: (() => void) | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const currentWindow = BrowserWindow.getAllWindows()[0]
    if (currentWindow?.isMinimized()) currentWindow.restore()
    currentWindow?.show()
    currentWindow?.focus()
  })
}

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: '贴吧清理助手',
    backgroundColor: '#f5f7fb',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  )

  const settingsStore = new SettingsStore()
  const taskLogStore = new TaskLogStore()
  let settings: AppSettings = await settingsStore.get()
  const accounts = new AccountSessionManager()
  await accounts.initialize(settings)
  const logger = createCoreLogger(mainWindow, taskLogStore)
  const engines = new Map<string, CoreEngine>()
  const getEngine = (accountId: string): CoreEngine => {
    const existing = engines.get(accountId)
    if (existing) return existing
    const account = accounts.getAccount(accountId)
    const transport = new ElectronSessionTransport(account.session, () => settings.requestTimeoutMs)
    const engine = new CoreEngine({ transport, logger })
    engines.set(accountId, engine)
    return engine
  }
  const invalidateEngine = (accountId: string, remove = false): void => {
    engines.get(accountId)?.invalidatePreviews()
    if (remove) engines.delete(accountId)
  }
  const findInstalledProduct = (): ReturnType<typeof findMsiRegistration> =>
    findMsiRegistration(app.getVersion(), process.execPath)
  const uninstallApp = async (dataMode: UninstallDataMode): Promise<void> => {
    const registration = await findInstalledProduct()
    if (!registration) {
      throw new CoreError('INVALID_INPUT', '未检测到当前版本的 MSI 安装信息')
    }
    if (dataMode !== 'keep') {
      for (const account of accounts.getState().accounts) invalidateEngine(account.accountId, true)
      await accounts.logoutAll()
      engines.clear()
    }
    if (dataMode === 'clear') {
      await taskLogStore.clear()
      await settingsStore.clear()
    }
    launchMsiUninstaller(registration, process.pid)
    const quitTimer = setTimeout(() => app.quit(), 250)
    quitTimer.unref()
  }
  disposeIpc?.()
  disposeIpc = registerIpcHandlers({
    mainWindow,
    accounts,
    getEngine,
    invalidateEngine,
    settingsStore,
    taskLogStore,
    getSettings: () => ({ ...settings }),
    setSettings: (value) => {
      settings = value
    },
    getAppInfo: async () => ({
      version: app.getVersion(),
      canUninstall: Boolean(await findInstalledProduct())
    }),
    uninstallApp
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    disposeIpc?.()
    disposeIpc = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.local.tieba-cleaner')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  void createWindow().catch(() => app.quit())

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(() => app.quit())
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'tieba.baidu.com'
  } catch {
    return false
  }
}
