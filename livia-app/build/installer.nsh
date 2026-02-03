; Livia Custom NSIS Installer Script
; Shows a helpful guide after installation

!macro customHeader
  ; Custom header - runs at the start
!macroend

!macro preInit
  ; Pre-initialization
!macroend

!macro customInit
  ; Custom initialization
!macroend

!macro customInstall
  ; Runs after files are installed
  ; Show a MessageBox with the guide
  MessageBox MB_OK|MB_ICONINFORMATION "Livia has been installed successfully!$\r$\n$\r$\nHow to find Livia:$\r$\n$\r$\n1. Look at your taskbar (bottom-right of screen)$\r$\n$\r$\n2. Click the arrow (^) to show hidden icons$\r$\n$\r$\n3. You'll see the Livia icon in the system tray$\r$\n$\r$\n4. Right-click it for options, or let it run!$\r$\n$\r$\nLivia automatically detects your music and$\r$\nshows it on Discord. Enjoy!"
!macroend

!macro customUnInstall
  ; Custom uninstall actions
!macroend
