import Cocoa

let app = NSApplication.shared
let delegate = AppDelegate()

// 最小菜单栏（Cmd+Q 退出等）
let menubar = NSMenu()
let appMenuItem = NSMenuItem()
menubar.addItem(appMenuItem)
let appMenu = NSMenu()
appMenu.addItem(NSMenuItem(title: "关于维基问答", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
appMenu.addItem(.separator())
appMenu.addItem(NSMenuItem(title: "隐藏维基问答", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
appMenu.addItem(NSMenuItem(title: "退出维基问答", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
appMenuItem.submenu = appMenu

// 编辑菜单（保证复制粘贴快捷键在 WebView 内可用）
let editMenu = NSMenu(title: "编辑")
editMenu.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
editMenu.addItem(NSMenuItem(title: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
editMenu.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
let editItem = NSMenuItem()
editItem.submenu = editMenu
menubar.addItem(editItem)

let windowItem = NSMenuItem()
let windowMenu = NSMenu(title: "窗口")
windowMenu.addItem(NSMenuItem(title: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
windowMenu.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
windowItem.submenu = windowMenu
menubar.addItem(windowItem)

appMenuItem.submenu = appMenu
app.mainMenu = menubar
app.delegate = delegate
app.run()
