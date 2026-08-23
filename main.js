const { protocol } = require('electron');

protocol.registerSchemesAsPrivileged([
  { scheme: 'kindlesync', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }
]);

require('./src/main/app').start();
