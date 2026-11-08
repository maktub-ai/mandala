module.exports = {
  appId: 'com.maktubcn.mandala',
  productName: 'Mandala',
  directories: { app: '.app', output: '../release/desktop' },
  files: ['main.cjs', 'updates.cjs', 'preload.cjs', 'runtime.cjs', 'tray.png', 'tray-color.png', 'icon-light.png', 'icon-dark.png', 'package.json'],
  extraResources: [{ from: '.runtime', to: 'runtime' }, { from: '.runtime/node_modules', to: 'runtime/node_modules', filter: ['**/*'] }],
  npmRebuild: false,
  asar: true,
  artifactName: 'Mandala-${version}-${os}-${arch}.${ext}',
  mac: { extendInfo: { NSMicrophoneUsageDescription: 'Mandala uses your microphone only when you start voice input, to transcribe speech into an editable draft.' }, entitlements: 'entitlements.mac.plist', entitlementsInherit: 'entitlements.mac.plist', icon: 'icons/icon.icns', target: ['dmg', 'zip'], category: 'public.app-category.productivity', identity: process.env.MANDALA_SIGNED === '1' ? undefined : '-', notarize: process.env.MANDALA_SIGNED === '1' },
  win: { icon: 'icons/icon.ico', target: ['nsis'], requestedExecutionLevel: 'asInvoker' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  forceCodeSigning: process.env.MANDALA_SIGNED === '1',
  publish: null
};
