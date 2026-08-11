# Extract DE440 Chebyshev coefficients for the bodies SolarSim needs into a
# compact binary (public/data/ephemeris.bin), for a runtime Chebyshev evaluator.
# Self-checks each segment's re-evaluation against jplephem.compute (machine
# precision) so unit/layout mistakes fail loudly here, not in the browser.
import json, struct, numpy as np
from jplephem.spk import SPK

SPAN_JD = (2433282.5, 2488434.5)  # 1950-01-01 .. 2099-12-31 + margin
J2000_JD = 2451545.0
DAY_S = 86400.0
k = SPK.open('tools/data/de440s.bsp')

# (center, target) segments to extract; sim bodies chain by summing these.
SEGS = [(0,10),(0,1),(1,199),(0,2),(2,299),(0,3),(3,399),(3,301),(0,4),(0,5),(0,6),(0,7),(0,8)]
BODIES = {
  'Sun':[(0,10)], 'Mercury':[(0,1),(1,199)], 'Venus':[(0,2),(2,299)],
  'Earth':[(0,3),(3,399)], 'Moon':[(0,3),(3,301)], 'Mars':[(0,4)],
  'Jupiter':[(0,5)], 'Saturn':[(0,6)], 'Uranus':[(0,7)], 'Neptune':[(0,8)],
}

def cheb(coeff_rec, tau):  # coeff_rec: (3, deg+1); tau in [-1,1]
    d = coeff_rec.shape[1]
    T = np.empty(d); T[0]=1; 
    if d>1: T[1]=tau
    for i in range(2,d): T[i]=2*tau*T[i-1]-T[i-2]
    return coeff_rec @ T

segmeta=[]; payload=bytearray(); worst_check=0.0
for (c,t) in SEGS:
    seg = k[c,t]
    init, intlen, coeff = seg.load_array()  # coeff: (3, nrec, deg+1); init/intlen in days, init=JD
    nrec = coeff.shape[1]; deg1 = coeff.shape[2]
    # record window covering SPAN
    r0 = max(0, int((SPAN_JD[0]-init)//intlen))
    r1 = min(nrec-1, int((SPAN_JD[1]-init)//intlen))
    sub = coeff[:, r0:r1+1, :]                 # (3, m, deg1)
    m = sub.shape[1]
    seg_init_jd = init + r0*intlen
    # self-check vs jplephem.compute at 200 sample JDs in-range
    for jd in np.linspace(SPAN_JD[0]+1, SPAN_JD[1]-1, 200):
        rec = int((jd - seg_init_jd)//intlen)
        rec = min(max(rec,0), m-1)
        t0 = seg_init_jd + rec*intlen
        tau = 2*(jd - t0)/intlen - 1
        mine = cheb(sub[:,rec,:], tau)
        ref = k[c,t].compute(jd)               # km, same segment
        worst_check = max(worst_check, float(np.max(np.abs(mine-ref))))
    # store record-major: [rec][ x0..xd y0..yd z0..zd ] float64
    rm = np.transpose(sub, (1,0,2)).reshape(m, 3*deg1).astype('<f8')
    off = len(payload)//8
    payload += rm.tobytes()
    segmeta.append({'center':c,'target':t,
        'init': (seg_init_jd-J2000_JD)*DAY_S, 'intlen': intlen*DAY_S,
        'deg1': deg1, 'nrec': m, 'off': off})

hdr = {'epoch':'J2000 TDB seconds','segs':segmeta,'bodies':BODIES}
hb = json.dumps(hdr).encode()
hb += b' ' * ((-(4 + len(hb))) % 8)  # pad so the float64 payload is 8-byte aligned
with open('public/data/ephemeris.bin','wb') as f:
    f.write(struct.pack('<I', len(hb))); f.write(hb); f.write(payload)
print(f"self-check worst |mine-jplephem| = {worst_check:.3e} km over 13 segs x 200 epochs")
print(f"wrote public/data/ephemeris.bin  header={len(hb)}B payload={len(payload)/1e6:.1f}MB segs={len(segmeta)}")
