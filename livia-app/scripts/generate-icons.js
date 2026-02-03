/**
 * Generate app icons from SVG source
 * Run: node scripts/generate-icons.js
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SOURCE_SVG = path.join(__dirname, '../../livia-logo.svg');
const OUTPUT_DIR = path.join(__dirname, '../assets');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function generateIcons() {
  console.log('🎨 Generating Livia app icons...\n');

  // Read the SVG
  const svgBuffer = fs.readFileSync(SOURCE_SVG);

  // Main icon - 512x512 PNG (high res for all platforms)
  console.log('📷 Generating icon.png (512x512)...');
  await sharp(svgBuffer)
    .resize(512, 512, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 } 
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'icon.png'));

  // macOS template icon - 16x16 (for menu bar, needs to be simple)
  console.log('📷 Generating iconTemplate.png (16x16)...');
  await sharp(svgBuffer)
    .resize(16, 16, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 } 
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'iconTemplate.png'));

  // macOS template @2x - 32x32
  console.log('📷 Generating iconTemplate@2x.png (32x32)...');
  await sharp(svgBuffer)
    .resize(32, 32, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 } 
    })
    .png()
    .toFile(path.join(OUTPUT_DIR, 'iconTemplate@2x.png'));

  // For Windows ICO, we need to generate multiple sizes
  // Generate 256x256 PNG first
  console.log('📷 Generating icon-256.png (256x256)...');
  const icon256Path = path.join(OUTPUT_DIR, 'icon-256.png');
  await sharp(svgBuffer)
    .resize(256, 256, { 
      fit: 'contain', 
      background: { r: 0, g: 0, b: 0, alpha: 0 } 
    })
    .png()
    .toFile(icon256Path);

  // Now convert to ICO using dynamic import for ES module
  console.log('📷 Generating icon.ico (Windows)...');
  try {
    const pngToIco = (await import('png-to-ico')).default;
    const icoBuffer = await pngToIco(icon256Path);
    fs.writeFileSync(path.join(OUTPUT_DIR, 'icon.ico'), icoBuffer);
  } catch (err) {
    console.log('⚠️  Could not generate .ico file:', err.message);
    console.log('   Using .png for Windows (electron-builder will handle it)');
  }

  console.log('\n✅ Icons generated successfully!');
  console.log(`📁 Output directory: ${OUTPUT_DIR}`);
}

generateIcons().catch(err => {
  console.error('❌ Error generating icons:', err);
  process.exit(1);
});
