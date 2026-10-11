# Canopy Ranger

Phone display for the Canopy Ranger, a handheld LoRa link tester used to survey a site before sensors are fitted.

Open it in **Chrome on Android**, press **Connect**, and pick "Canopy Ranger". It uses Web Bluetooth, so iPhone Safari won't work.

- Live SNR with a GOOD / MARGINAL / POOR verdict every 5 seconds
- **MARK** runs a 10-ping survey of the spot you're standing on. A magnet on the Ranger does the same
- GPS on every ping, plus a north-up coverage plot that works offline
- Export to CSV or GeoJSON for ArcGIS or QGIS
- Everything is saved on the phone as you go

Add `?demo=1` to the address for a fake Ranger to practise with.

Open it once with signal before heading out, so it's cached for use offline.

This repo is a published copy of `ranger-app/` from the main Canopy project, so make changes there.
