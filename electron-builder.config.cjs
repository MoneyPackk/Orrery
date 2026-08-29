/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.orrery.mission-control",
  productName: "Orrery Mission Control",
  asar: true,
  forceCodeSigning: false,
  directories: {
    output: "release",
  },
  files: [
    "dist/**/*",
    "dist-electron/**/*",
    "package.json",
  ],
  win: {
    executableName: "orrery-mission-control",
    signAndEditExecutable: false,
    target: ["nsis", "portable", "zip"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  mac: {
    identity: null,
    target: ["dmg", "zip"],
  },
  linux: {
    executableName: "orrery-mission-control",
    category: "Development",
    target: ["AppImage", "deb"],
  },
};
