// Electron entry. Two roles for one executable:
// - the Synodica desktop app (desktop/app.cjs): window, native menu, the office server child;
// - the dsh-pet desktop helper, when the server's pet host starts it with this Electron
//   (desktop/pet-helper.cjs): the upstream helper runs unmodified, with its profile in our app data.
// A packaged app always runs this entry, whatever script path is on its command line, so the pet
// reuses the bundled executable without any separate Electron install.
const petHelper = require('./pet-helper.cjs')

const helperLaunch = petHelper.detectHelperLaunch(process.argv, process.env)
if (helperLaunch) petHelper.runHelper(require('electron').app, helperLaunch)
else require('./app.cjs')
