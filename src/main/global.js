const { BrowserWindow, Menu, Notification, app } = require('electron');

const fs = require('fs');
const fsOriginal = require('original-fs');
const os = require('os');
const path = require('path');

const fse = require('fs-extra');
const i18next = require('i18next');
const moment = require('moment');
const Seven = require('node-7z');
const sevenBin = require('7zip-bin');

let win;
let settingsWin;
let aboutWin;
let settings;
let writeQueue = Promise.resolve();

const appVersion = "2.0.3";
const updateLink = "https://api.github.com/repos/dyang886/Game-Save-Manager/releases/latest";
let status = {
    backuping: false,
    restoring: false,
    migrating: false,
    updating_db: false,
    exporting: false
}

// Menu settings
const initializeMenu = () => {
    return [
        {
            label: i18next.t("main.options"),
            submenu: [
                {
                    label: i18next.t("settings.title"),
                    click() {
                        let settings_window_size = [650, 700];
                        // Check if settingsWin is already open
                        if (!settingsWin || settingsWin.isDestroyed()) {
                            settingsWin = new BrowserWindow({
                                width: settings_window_size[0],
                                height: settings_window_size[1],
                                minWidth: settings_window_size[0],
                                minHeight: settings_window_size[1],
                                icon: path.join(__dirname, "../assets/setting.ico"),
                                parent: win,
                                modal: true,
                                webPreferences: {
                                    preload: path.join(__dirname, "preload.js"),
                                },
                            });

                            settingsWin.setMenuBarVisibility(false);
                            settingsWin.loadFile(path.join(__dirname, "../renderer/html/settings.html"));

                            settingsWin.on("closed", () => {
                                settingsWin = null;
                            });
                        } else {
                            settingsWin.focus();
                        }
                    },
                },
                {
                    label: i18next.t("about.title"),
                    click() {
                        let about_window_size = [480, 290];
                        if (!aboutWin || aboutWin.isDestroyed()) {
                            aboutWin = new BrowserWindow({
                                width: about_window_size[0],
                                height: about_window_size[1],
                                resizable: false,
                                icon: path.join(__dirname, "../assets/logo.ico"),
                                parent: win,
                                modal: true,
                                webPreferences: {
                                    preload: path.join(__dirname, "preload.js"),
                                },
                            });

                            aboutWin.setMenuBarVisibility(false);
                            aboutWin.loadFile(path.join(__dirname, "../renderer/html/about.html"));

                            aboutWin.on("closed", () => {
                                aboutWin = null;
                            });
                        } else {
                            aboutWin.focus();
                        }
                    },
                },
            ],
        },
        {
            label: i18next.t("main.export"),
            click() {
                win.webContents.send("select-backup-count");
            },
        },
    ];
}

// Main window
const createMainWindow = async () => {
    let main_window_size = [1100, 750];
    win = new BrowserWindow({
        width: main_window_size[0],
        height: main_window_size[1],
        minWidth: main_window_size[0],
        minHeight: main_window_size[1],
        icon: path.join(__dirname, "../assets/logo.ico"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
        },
    });

    // win.webContents.openDevTools();
    win.loadFile(path.join(__dirname, "../renderer/html/index.html"));
    const menu = Menu.buildFromTemplate(initializeMenu());
    Menu.setApplicationMenu(menu);

    win.on("closed", () => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (window !== win) {
                window.close();
            }
        });

        if (process.platform !== "darwin") {
            app.quit();
        }
    });
};

async function getLatestVersion() {
    try {
        const response = await fetch(updateLink);
        const data = await response.json();
        const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, "") : null;

        return latestVersion;

    } catch (error) {
        console.error("Error checking for update:", error.stack);
        return null;
    }
}

async function checkAppUpdate() {
    try {
        const response = await fetch(updateLink);
        const data = await response.json();
        const latestVersion = data.tag_name ? data.tag_name.replace(/^v/, "") : appVersion;

        if (latestVersion > appVersion) {
            showNotification(
                "info",
                i18next.t('alert.update_available'),
                `${i18next.t('alert.new_version_found', { old_version: appVersion, new_version: latestVersion })}\n` +
                `${i18next.t('alert.new_version_found_text')}`
            );
        }

    } catch (error) {
        console.error("Error checking for update:", error.stack);
        showNotification(
            "warning",
            i18next.t('alert.update_check_failed'),
            i18next.t('alert.update_check_failed_text')
        );
    }
}

function showNotification(type, title, body) {
    icon_map = {
        'info': path.join(__dirname, "../assets/information.png"),
        'warning': path.join(__dirname, "../assets/warning.png"),
        'critical': path.join(__dirname, "../assets/critical.png")
    }

    new Notification({
        title: title,
        body: body,
        icon: icon_map[type],
    }).show()
}

function getGameDisplayName(gameObj) {
    if (settings.language === "en_US") {
        return gameObj.title;
    } else if (settings.language === "zh_CN") {
        return gameObj.zh_CN || gameObj.title;
    }
}

// Calculates the total size of a directory or file
function calculateDirectorySize(directoryPath, ignoreConfig = true) {
    let totalSize = 0;

    try {
        if (fsOriginal.statSync(directoryPath).isDirectory()) {
            const files = fsOriginal.readdirSync(directoryPath);
            files.forEach(file => {
                if (ignoreConfig && file === 'backup_info.json') {
                    return;
                }
                const filePath = path.join(directoryPath, file);
                if (fsOriginal.statSync(filePath).isDirectory()) {
                    totalSize += calculateDirectorySize(filePath);
                } else {
                    totalSize += fsOriginal.statSync(filePath).size;
                }
            });

        } else {
            totalSize += fsOriginal.statSync(directoryPath).size;
        }

    } catch (error) {
        console.error(`Error calculating directory size for ${directoryPath}:`, error);
    }

    return totalSize;
}

// Ensure all files under a path have writable permission
function ensureWritable(pathToCheck) {
    if (!fsOriginal.existsSync(pathToCheck)) {
        return;
    }

    const stats = fsOriginal.statSync(pathToCheck);

    if (stats.isDirectory()) {
        const items = fsOriginal.readdirSync(pathToCheck);

        for (const item of items) {
            const fullPath = path.join(pathToCheck, item);
            ensureWritable(fullPath);
        }

    } else {
        if (!(stats.mode & 0o200)) {
            fsOriginal.chmod(pathToCheck, 0o666);
            console.log(`Changed permissions for file: ${pathToCheck}`);
        }
    }
}

function getNewestBackup(wiki_page_id) {
    const backupDir = path.join(settings.backupPath, wiki_page_id.toString());

    if (!fsOriginal.existsSync(backupDir)) {
        return i18next.t('main.no_backups');
    }

    const backups = fsOriginal.readdirSync(backupDir).filter(file => {
        const fullPath = path.join(backupDir, file);
        return fsOriginal.statSync(fullPath).isDirectory();
    });

    if (backups.length === 0) {
        return i18next.t('main.no_backups');
    }

    const latestBackup = backups.sort((a, b) => {
        return b.localeCompare(a);
    })[0];

    return moment(latestBackup, 'YYYY-MM-DD_HH-mm').format('YYYY/MM/DD HH:mm');
}

function updateStatus(statusKey, statusValue) {
    status[statusKey] = statusValue;
}

function fsOriginalCopyFolder(source, target) {
    fsOriginal.mkdirSync(target, { recursive: true });

    const items = fsOriginal.readdirSync(source);

    for (const item of items) {
        const sourcePath = path.join(source, item);
        const destinationPath = path.join(target, item);

        const stats = fsOriginal.statSync(sourcePath);

        if (stats.isDirectory()) {
            fsOriginalCopyFolder(sourcePath, destinationPath);
        } else {
            fsOriginal.copyFileSync(sourcePath, destinationPath);
        }
    }
}

async function exportBackups(count, exportPath) {
    const progressId = 'export';
    const progressTitle = i18next.t('alert.exporting');
    const sourcePath = settings.backupPath;

    try {
        if (!status.exporting) {
            status.exporting = true;
            win.webContents.send('update-progress', progressId, progressTitle, 'start');

            // Build the list of relative paths to archive
            let itemsToArchive = [];

            const customEntriesPath = path.join(sourcePath, 'custom_entries.json');
            if (fsOriginal.existsSync(customEntriesPath)) {
                itemsToArchive.push('custom_entries.json');
            }

            const items = fsOriginal.readdirSync(sourcePath);
            const gameFolders = items.filter(item => {
                const fullPath = path.join(sourcePath, item);
                return fsOriginal.lstatSync(fullPath).isDirectory();
            });

            // For each game folder, select the most recent backup instances
            for (const gameId of gameFolders) {
                const gameFolderPath = path.join(sourcePath, gameId);
                let backups = fsOriginal.readdirSync(gameFolderPath).filter(item => {
                    const fullPath = path.join(gameFolderPath, item);
                    return fsOriginal.lstatSync(fullPath).isDirectory();
                });

                backups.sort((a, b) => { return b.localeCompare(a); });
                backups = backups.slice(0, count);

                backups.forEach(backupFolder => {
                    itemsToArchive.push(path.join(gameId, backupFolder));
                });
            }

            const timestamp = moment().format('YYYY-MM-DD_HH-mm');
            const finalFileName = `GSMBackup-${timestamp}.gsm`;
            const finalDestPath = path.join(exportPath, finalFileName);

            const sevenOptions = {
                yes: true,
                recursive: true,
                $bin: sevenBin.path7za,
                $progress: true,
                $raw: []
            };

            const originalCwd = process.cwd();
            process.chdir(sourcePath);
            const archiveStream = Seven.add(finalDestPath, itemsToArchive, sevenOptions);

            archiveStream.on('progress', (progress) => {
                if (progress.percent) {
                    win.webContents.send('update-progress', progressId, progressTitle, Math.floor(progress.percent));
                }
            });

            await new Promise((resolve, reject) => {
                archiveStream.on('end', resolve);
                archiveStream.on('error', reject);
            });

            process.chdir(originalCwd);
            win.webContents.send('update-progress', progressId, progressTitle, 'end');
            win.webContents.send('show-alert', 'success', i18next.t('alert.export_success'));
            status.exporting = false;
        }

    } catch (error) {
        console.error(`An error occurred while exporting backups: ${error.message}`);
        win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_export'), error.message);
        win.webContents.send('update-progress', progressId, progressTitle, 'end');
        status.exporting = false;
    }
}

const placeholder_mapping = {
    // Windows
    '{{p|username}}': os.userInfo().username,
    '{{p|userprofile}}': process.env.USERPROFILE || os.homedir(),
    '{{p|userprofile/documents}}': path.join(process.env.USERPROFILE || os.homedir(), 'Documents'),
    '{{p|userprofile/appdata/locallow}}': path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'LocalLow'),
    '{{p|appdata}}': process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'),
    '{{p|localappdata}}': process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'),
    '{{p|programfiles}}': process.env.PROGRAMFILES || 'C:\\Program Files',
    '{{p|programdata}}': process.env.PROGRAMDATA || 'C:\\ProgramData',
    '{{p|public}}': path.join(process.env.PUBLIC || 'C:\\Users\\Public'),
    '{{p|windir}}': process.env.WINDIR || 'C:\\Windows',

    // Registry
    '{{p|hkcu}}': 'HKEY_CURRENT_USER',
    '{{p|hklm}}': 'HKEY_LOCAL_MACHINE',
    '{{p|wow64}}': 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node',

    // Mac
    '{{p|osxhome}}': os.homedir(),

    // Linux
    '{{p|linuxhome}}': os.homedir(),
    '{{p|xdgdatahome}}': process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    '{{p|xdgconfighome}}': process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
};

const placeholder_identifier = {
    '{{p|username}}': '{{p1}}',
    '{{p|userprofile}}': '{{p2}}',
    '{{p|userprofile/documents}}': '{{p3}}',
    '{{p|userprofile/appdata/locallow}}': '{{p4}}',
    '{{p|appdata}}': '{{p5}}',
    '{{p|localappdata}}': '{{p6}}',
    '{{p|programfiles}}': '{{p7}}',
    '{{p|programdata}}': '{{p8}}',
    '{{p|public}}': '{{p9}}',
    '{{p|windir}}': '{{p10}}',
    '{{p|game}}': '{{p11}}',
    '{{p|uid}}': '{{p12}}',
    '{{p|steam}}': '{{p13}}',
    '{{p|uplay}}': '{{p14}}',
    '{{p|ubisoftconnect}}': '{{p14}}',
    '{{p|hkcu}}': '{{p15}}',
    '{{p|hklm}}': '{{p16}}',
    '{{p|wow64}}': '{{p17}}',
    '{{p|osxhome}}': '{{p18}}',
    '{{p|linuxhome}}': '{{p19}}',
    '{{p|xdgdatahome}}': '{{p20}}',
    '{{p|xdgconfighome}}': '{{p21}}',
};

const osKeyMap = {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux'
};

// ======================================================================
// Settings
// ======================================================================
const loadSettings = () => {
    const userDataPath = app.getPath("userData");
    const appDataPath = app.getPath("appData");
    const settingsPath = path.join(userDataPath, "GSM Settings", "settings.json");

    const locale_mapping = {
        'en-US': 'en_US',
        'zh-Hans-CN': 'zh_CN',
        'zh-Hans-SG': 'zh_CN',
        'zh-Hant-HK': 'zh_TW',
        'zh-Hant-MO': 'zh_TW',
        'zh-Hant-TW': 'zh_TW',
    };

    const systemLocale = app.getLocale();
    // console.log(`Current locale: ${systemLocale}; Preferred languages: ${app.getPreferredSystemLanguages()}`);
    const detectedLanguage = locale_mapping[systemLocale] || 'en_US';

    // Default settings
    const defaultSettings = {
        theme: 'dark',
        language: detectedLanguage,
        backupPath: path.join(appDataPath, "GSM Backups"),
        exportPath: "",
        maxBackups: 5,
        autoAppUpdate: true,
        autoDbUpdate: false,
        gameInstalls: 'uninitialized',
        pinnedGames: []
    };

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        settings = { ...defaultSettings, ...JSON.parse(data) };

    } catch (err) {
        console.error("Error loading settings, using defaults:", err);
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings), 'utf8');
        settings = defaultSettings;
    }
};

function saveSettings(key, value) {
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'GSM Settings', 'settings.json');

    settings[key] = value;

    // Queue the write operation to prevent simultaneous writes
    writeQueue = writeQueue.then(() => {
        return new Promise((resolve, reject) => {
            fs.writeFile(settingsPath, JSON.stringify(settings), (writeErr) => {
                if (writeErr) {
                    console.error('Error saving settings:', writeErr);
                    reject(writeErr);
                } else {
                    console.log(`Settings updated successfully: ${key}: ${value}`);

                    if (key === 'theme') {
                        BrowserWindow.getAllWindows().forEach((window) => {
                            window.webContents.send('apply-theme', value);
                        });
                    }

                    if (key === 'gameInstalls') {
                        win.webContents.send('update-backup-table');
                    }

                    if (key === 'language') {
                        i18next.changeLanguage(value).then(() => {
                            BrowserWindow.getAllWindows().forEach((window) => {
                                window.webContents.send('apply-language');
                            });
                            const menu = Menu.buildFromTemplate(initializeMenu());
                            Menu.setApplicationMenu(menu);
                            resolve();
                        }).catch(reject);
                    } else {
                        resolve();
                    }
                }
            });
        });
    }).catch((err) => {
        console.error('Error in write queue:', err);
    });
}

async function moveFilesWithProgress(sourceDir, destinationDir) {
    let totalSize = 0;
    let movedSize = 0;
    let errors = [];
    status.migrating = true;
    const progressId = 'migrate-backups';
    const progressTitle = i18next.t('alert.migrate_backups');

    const moveAndTrackProgress = async (srcDir, destDir) => {
        try {
            const items = fsOriginal.readdirSync(srcDir, { withFileTypes: true });

            for (const item of items) {
                const srcPath = path.join(srcDir, item.name);
                const destPath = path.join(destDir, item.name);

                if (item.isDirectory()) {
                    fse.ensureDirSync(destPath);
                    await moveAndTrackProgress(srcPath, destPath);
                } else {
                    const fileStats = fsOriginal.statSync(srcPath);
                    const readStream = fsOriginal.createReadStream(srcPath);
                    const writeStream = fsOriginal.createWriteStream(destPath);

                    readStream.on('data', (chunk) => {
                        movedSize += chunk.length;
                        const progressPercentage = Math.round((movedSize / totalSize) * 100);
                        win.webContents.send('update-progress', progressId, progressTitle, progressPercentage);
                    });

                    await new Promise((resolve, reject) => {
                        readStream.pipe(writeStream);
                        readStream.on('error', reject);
                        writeStream.on('error', reject);
                        writeStream.on('finish', () => {
                            fsOriginal.promises.utimes(destPath, fileStats.atime, fileStats.mtime)
                                .then(() => fsOriginal.promises.rm(srcPath))
                                .then(resolve)
                                .catch(reject);
                        });
                    });
                }
            }
            await fsOriginal.promises.rm(srcDir, { recursive: true });

        } catch (err) {
            errors.push(`Error moving file or directory: ${err.message}`);
        }
    };

    if (fsOriginal.existsSync(sourceDir)) {
        totalSize = calculateDirectorySize(sourceDir, false);

        win.webContents.send('update-progress', progressId, progressTitle, 'start');
        await moveAndTrackProgress(sourceDir, destinationDir);
        win.webContents.send('update-progress', progressId, progressTitle, 'end');

        if (errors.length > 0) {
            console.log(errors);
            win.webContents.send('show-alert', 'modal', i18next.t('alert.error_during_backup_migration'), errors);
        } else {
            win.webContents.send('show-alert', 'success', i18next.t('alert.backup_migration_success'));
        }
    }
    saveSettings('backupPath', destinationDir);
    win.webContents.send('update-restore-table');
    status.migrating = false;
}

module.exports = {
    createMainWindow,
    getMainWin: () => win,
    getSettingsWin: () => settingsWin,
    getStatus: () => status,
    updateStatus,
    getCurrentVersion: () => appVersion,
    getLatestVersion,
    checkAppUpdate,
    getGameDisplayName,
    calculateDirectorySize,
    ensureWritable,
    getNewestBackup,
    fsOriginalCopyFolder,
    exportBackups,
    placeholder_mapping,
    placeholder_identifier,
    osKeyMap,
    loadSettings,
    saveSettings,
    getSettings: () => settings,
    moveFilesWithProgress,
};
