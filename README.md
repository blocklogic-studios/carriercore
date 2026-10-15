# CarrierCore

Minecraft Bedrock addon that simulates a multi-carrier cellular network.

Build towers, register carriers, issue SIMs, send texts, and deal with real failures — overheating data centers, missing backhaul, maintenance windows, the works.

## Requirements

- Minecraft Bedrock **1.26+**
- Experiments: **Beta APIs** (Script API)

## Features (v2.2)

- Multi-carrier networks with peering
- Cell towers (base + BBU + antennas + power + cooling)
- Fiber backhaul and microwave links
- Data centers with heat / cooling simulation
- Dual SIM, messaging, voicemail
- WiFi routers + fiber green boxes
- Satellite dishes & receivers
- Network management terminal
- Phones: generic smartphone, iPhone 17, Galaxy S25, Pixel 10

## Install

### Option A — development packs (easiest while testing)

1. Clone this repo
2. Copy `BP/CarrierCore_BP` into your world's `development_behavior_packs` folder
3. Copy `RP/CarrierCore_RP` into `development_resource_packs`
4. Enable both packs on the world
5. Turn on **Beta APIs** under Experiments

### Option B — build an `.mcaddon`

```bash
# From the repo root
cd BP && zip -r ../CarrierCore_BP.mcpack CarrierCore_BP && cd ..
cd RP && zip -r ../CarrierCore_RP.mcpack CarrierCore_RP && cd ..
zip CarrierCore.mcaddon CarrierCore_BP.mcpack CarrierCore_RP.mcpack
```

Open the `.mcaddon` on a device with Minecraft to import both packs, then enable them and turn on **Beta APIs**.

> Packaged releases will show up under [Releases](../../releases) once we publish one.

## Studio

Made by [Blocklogic Studio](https://github.com/blocklogic-studios).

## License

All rights reserved for now. Source is public so people can learn from it and report issues.
