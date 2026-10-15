# Missing large scripts

These two files are too large for the automated upload path used here. Drop them in from the v2.2 `.mcaddon`:

```
BP/CarrierCore_BP/scripts/core/NetworkManager.js   (~60 KB)
BP/CarrierCore_BP/scripts/ui/handlers.js            (~47 KB)
```

From the extracted pack:

```bash
git clone https://github.com/blocklogic-studios/carriercore.git
cd carriercore
# copy from your extracted CarrierCore_BP:
cp /path/to/CarrierCore_BP/scripts/core/NetworkManager.js BP/CarrierCore_BP/scripts/core/
cp /path/to/CarrierCore_BP/scripts/ui/handlers.js BP/CarrierCore_BP/scripts/ui/
git add BP/CarrierCore_BP/scripts/
git commit -m "Add NetworkManager and UI handlers"
git push
```

PNG textures (`textures/`, `pack_icon.png`) also need a local add — same process.
