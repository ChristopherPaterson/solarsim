# Starship models (optional easter eggs)

Drop **glTF `.glb`** ship models here and they get parked in orbit around a
planet, shown by the **STARSHIPS** toggle in the LAYERS panel. Any file that
isn't present is simply skipped, so this folder can stay empty.

Expected filenames and where each one is parked (edit the `SHIPS` table in
`src/main.ts` to change the mapping / orbit / size):

| file | orbits |
|------|--------|
| `shuttle.glb` | Earth (low orbit) |
| `enterprise-d.glb` | Saturn |
| `enterprise-e.glb` | Jupiter |
| `voyager.glb` | Neptune |
| `defiant.glb` | Mars |
| `enterprise-refit.glb` | Uranus |

Notes:
- Supply your own model files — source models you have the right to use, and
  check each model's individual licence. Star Trek ship designs are Paramount
  intellectual property; only add models you're permitted to use.
- The Space Shuttle: NASA publishes public-domain 3D models.
- Models are auto-centred and scaled to a fraction of the body radius, so any
  reasonable `.glb` works regardless of its original scale or origin. Prefer
  `.glb` (single file with embedded textures).
