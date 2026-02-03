/**
 * Cross-platform Auto-Launch Manager
 * Handles starting the app with the system on Windows, macOS, and Linux
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class AutoLaunch {
  constructor() {
    this.appName = 'Livia';
    this.appPath = app.getPath('exe');
    this.platform = process.platform;
  }

  /**
   * Enable auto-launch on system startup
   */
  async enable() {
    try {
      switch (this.platform) {
        case 'win32':
          await this.enableWindows();
          break;
        case 'darwin':
          this.enableMacOS();
          break;
        case 'linux':
          this.enableLinux();
          break;
      }
      console.log('✅ Auto-launch enabled');
      return true;
    } catch (error) {
      console.error('Failed to enable auto-launch:', error.message);
      return false;
    }
  }

  /**
   * Disable auto-launch on system startup
   */
  async disable() {
    try {
      switch (this.platform) {
        case 'win32':
          await this.disableWindows();
          break;
        case 'darwin':
          this.disableMacOS();
          break;
        case 'linux':
          this.disableLinux();
          break;
      }
      console.log('✅ Auto-launch disabled');
      return true;
    } catch (error) {
      console.error('Failed to disable auto-launch:', error.message);
      return false;
    }
  }

  // ============ Windows ============
  async enableWindows() {
    const Winreg = require('winreg');
    const key = new Winreg({
      hive: Winreg.HKCU,
      key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    });

    return new Promise((resolve, reject) => {
      key.set(this.appName, Winreg.REG_SZ, `"${this.appPath}"`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disableWindows() {
    const Winreg = require('winreg');
    const key = new Winreg({
      hive: Winreg.HKCU,
      key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    });

    return new Promise((resolve) => {
      key.remove(this.appName, () => {
        // Ignore error if key doesn't exist
        resolve();
      });
    });
  }

  // ============ macOS ============
  enableMacOS() {
    // Use Login Items via AppleScript
    const appPath = this.appPath.replace(/\/Contents\/MacOS\/.*$/, '');
    
    // First remove if exists
    try {
      execSync(`osascript -e 'tell application "System Events" to delete login item "${this.appName}"'`, { stdio: 'ignore' });
    } catch {}

    // Then add
    execSync(`osascript -e 'tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:false}'`);
  }

  disableMacOS() {
    try {
      execSync(`osascript -e 'tell application "System Events" to delete login item "${this.appName}"'`, { stdio: 'ignore' });
    } catch {
      // Ignore if not found
    }
  }

  // ============ Linux ============
  enableLinux() {
    const autostartDir = path.join(app.getPath('home'), '.config', 'autostart');
    const desktopFile = path.join(autostartDir, `${this.appName.toLowerCase()}.desktop`);

    // Ensure autostart directory exists
    if (!fs.existsSync(autostartDir)) {
      fs.mkdirSync(autostartDir, { recursive: true });
    }

    const content = `[Desktop Entry]
Type=Application
Name=${this.appName}
Exec="${this.appPath}"
Icon=livia
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=Music Activity Display for Discord
`;

    fs.writeFileSync(desktopFile, content);
  }

  disableLinux() {
    const desktopFile = path.join(
      app.getPath('home'), 
      '.config', 
      'autostart', 
      `${this.appName.toLowerCase()}.desktop`
    );

    if (fs.existsSync(desktopFile)) {
      fs.unlinkSync(desktopFile);
    }
  }
}

module.exports = AutoLaunch;
