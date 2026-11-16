# Sounds

Every file in `sounds/` is a recording released into the public domain (CC0). Nothing here needs attribution; it is
listed so anyone can trace a sound to its source.

| Files | Source | License |
|---|---|---|
| `rifle_*`, `pistol_*`, `smg_*`, `shotgun_*`, `sniper_*` | The Free Firearm Sound Library, via OpenGameArt (opengameart.org/content/the-free-firearm-sound-library) | CC0 |
| `reload_*` | "Gun reload sounds" (airsoft), via OpenGameArt (opengameart.org/content/gun-reload-sounds) | CC0 |

How they were made: single shots cut from the library's recordings (AK-47, AR-15, Walther PPQ, 1911, Bersa, Carl Gustav
M45, PPSh, Benelli Nova, Charles Daly pump, Tikka T3, Savage .300 Blackout), two takes each from the near microphone and
two from mid distance (the range's echo kept), 0.9 s and 1.4 s, faded out, normalised, mono 44.1 kHz MP3 at 96 kbps;
reloads cut into a magazine-out and a magazine-in or slide piece at 80 kbps. Which gun plays which recording, and at what
pitch, is `GUNCLIP` in game.js.
