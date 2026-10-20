const { default: pngToIco } = require('png-to-ico');
const fs = require('fs');
const path = require('path');

pngToIco([
  path.join(__dirname, 'resources', 'northlight-meetings-icon-48x48.png'),
  path.join(__dirname, 'resources', 'northlight-meetings-icon-120x120.png'),
  path.join(__dirname, 'resources', 'northlight-meetings-icon-512x512.png'),
])
  .then(buf => {
    fs.writeFileSync(path.join(__dirname, 'resources', 'icon.ico'), buf);
    console.log('icon.ico written to resources/');
  })
  .catch(console.error);
