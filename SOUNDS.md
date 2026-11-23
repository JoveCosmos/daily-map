# Sounds

Every file in `sounds/` is a recording released into the public domain (CC0). Nothing here needs attribution; it is
listed so anyone can trace a sound to its source.

| Files | Source | License |
|---|---|---|
| `rifle_*`, `pistol_*`, `smg_*`, `shotgun_*`, `sniper_*`, `ak_*`, `m4_*`, `glock_*`, `usp_*`, `deagle_*` | The Free Firearm Sound Library, via OpenGameArt (opengameart.org/content/the-free-firearm-sound-library) | CC0 |
| `mag_out`, `mag_in`, `slide` | "Handgun Reload Sound Effect" (a real handgun), via OpenGameArt (opengameart.org/content/handgun-reload-sound-effect) | CC0 |
| `bolt_back`, `bolt_fwd`, `charge`, `click` | "equipment clicks III" (a real bolt-action rifle), via OpenGameArt (opengameart.org/content/equipment-clicks-iii) | CC0 |
| `knife_slash1`, `knife_slash2`, `knife_draw` | "80 CC0 RPG SFX" (blade_01 to blade_03), via OpenGameArt (opengameart.org/content/80-cc0-rpg-sfx) | CC0 |
| `step1` to `step6` | Fantozzi's footsteps on stone (freesound.org/people/Fantozzi), via OpenGameArt (opengameart.org/content/fantozzis-footsteps-grasssand-stone) | CC0 |
| `boom1` to `boom3`, `pop` | "25 CC0 bang / firework SFX", via OpenGameArt (opengameart.org/content/25-cc0-bang-firework-sfx) | CC0 |

How they were made: single shots cut from the library's recordings (AK-47, AR-15, Walther PPQ, 1911, Bersa, Carl Gustav
M45, PPSh, Benelli Nova, Charles Daly pump, Tikka T3, Savage .300 Blackout), two takes each from the near microphone and
two from mid distance (the range's echo kept), 0.9 s and 1.4 s, faded out, normalised, mono 44.1 kHz MP3 at 96 kbps;
reloads, bolt clicks and steps cut tight and dry (low rumble and room tail removed, so a reload sounds like the gun in your
hands, not a basement), explosions kept whole. Reload sequences per kind of gun are RELOADS in game.js. The echo, a bullet's
crack or whiz, impacts and hits are made in code (game.js), not recorded. Which gun plays which recording, and at what
pitch, is `GUNCLIP` in game.js.

The guns drawn in the game have their own sounds (2026-11-23), each cut from its own real gun in the library and shaped
toward its character, so no two sound alike: `ak_*` the AK-47 (the last shot of a string, so the tail is clean),
pitched down 7%, chest thump at 110 Hz and bark at 600 Hz, a short slap of echo; `m4_*` the AR-15, low end cut, crack at
3.2 kHz, dry and short; `glock_*` the Walther PPQ 9 mm, crisp; `usp_*` the same 9 mm shot under a 1.1 kHz low-pass, a
suppressed thud (the slide click is played over it in code); `deagle_*` the 1911 .45, pitched down 14%, heavy low end
and a longer tail. Near takes from the close microphone, far takes from the distant one with more of the range.
The knife: a real blade over the code's swish on a slash, the blade's draw when it comes out.
