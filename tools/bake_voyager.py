# Bake Voyager 1's real JPL trajectory into a compact polyline in the sim's
# barycentric ecliptic-J2000 frame: [tdb_s, x, y, z] per sample (m). SPICE reads
# the Type-1 flyby segments and chains -31 -> SSB in ECLIPJ2000 directly.
import struct, numpy as np, spiceypy as sp
J2000=2451545.0; DAY=86400.0
sp.furnsh('tools/data/vgr1.merged.bsp')  # 1977-1986, incl. Jupiter/Saturn flybys
sp.furnsh('tools/data/vgr1.x2100.bsp')   # 1981-2100 cruise
# et = seconds past J2000 TDB (no leap-second kernel needed at this precision).
ets = np.concatenate([
    np.linspace((2443397.0-J2000)*DAY, (2444600.0-J2000)*DAY, 300),  # launch+flybys, dense
    np.linspace((2444600.0-J2000)*DAY, (2488000.0-J2000)*DAY, 760),   # 1981..2099 cruise
])
out=[]
for et in ets:
    st,_ = sp.spkezr('-31', float(et), 'ECLIPJ2000', 'NONE', '0')  # km, barycentric ecliptic
    out.append((float(et), st[0]*1000, st[1]*1000, st[2]*1000))     # -> m
with open('public/data/voyager1.bin','wb') as f:
    f.write(struct.pack('<I', len(out)))
    for row in out: f.write(struct.pack('<4d', *row))
AU=1.495978707e11
print(f"wrote {len(out)} samples; Voyager r: {np.hypot(out[0][1],out[0][2],out[0][3])/AU:.2f} AU -> {np.hypot(out[-1][1],out[-1][2],out[-1][3])/AU:.1f} AU")
sp.kclear()
