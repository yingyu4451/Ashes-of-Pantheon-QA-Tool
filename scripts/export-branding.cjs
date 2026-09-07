const { app, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')

const builderRequire = createRequire(require.resolve('electron-builder'))
const resourceRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const { Data } = resourceRequire('resedit')
const projectRoot = resolve(__dirname, '..')

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(resolve(projectRoot, 'resources/branding/logo-source.png'))
  if (source.isEmpty()) throw new Error('The selected logo source could not be loaded.')
  const icon = new Data.IconFile()

  for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) {
    const png = source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    icon.icons.push({ data: Data.RawIconItem.from(png, size, size, 32) })
    if (size === 256) writeFileSync(resolve(projectRoot, 'src/renderer/public/assets/qa-logo.png'), png)
  }

  writeFileSync(resolve(projectRoot, 'resources/branding/icon.ico'), Buffer.from(icon.generate()))
  writeFileSync(resolve(projectRoot, 'resources/branding/icon.png'), source.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  console.log('Exported renderer PNG, window PNG, and multi-resolution Windows ICO.')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
