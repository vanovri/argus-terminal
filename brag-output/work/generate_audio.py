import os
import wave
import numpy as np

SAMPLE_RATE = 44100
DURATION = 18.0
NUM_SAMPLES = int(SAMPLE_RATE * DURATION)
BPM = 120.0
BEAT_SEC = 60.0 / BPM  # 0.5s


def generate_soundtrack(out_path: str):
    t = np.linspace(0.0, DURATION, NUM_SAMPLES, endpoint=False, dtype=np.float64)
    left = np.zeros(NUM_SAMPLES, dtype=np.float64)
    right = np.zeros(NUM_SAMPLES, dtype=np.float64)

    rng = np.random.default_rng(42)

    def add_stereo(sig_l, sig_r, start_sec, gain=1.0):
        idx0 = int(start_sec * SAMPLE_RATE)
        if idx0 >= NUM_SAMPLES or idx0 < 0:
            return
        n = min(len(sig_l), NUM_SAMPLES - idx0)
        if n <= 0:
            return
        left[idx0 : idx0 + n] += sig_l[:n] * gain
        right[idx0 : idx0 + n] += sig_r[:n] * gain

    # 1. Warm Dark-Synth Pad Progression (Dm9 -> Bbmaj7 -> Gm9 -> A7sus4)
    # 4.5s per chord across 18.0s
    chords = [
        (0.0, 4.5, [146.83, 174.61, 220.00, 261.63, 329.63]),   # Dm9 (D3, F3, A3, C4, E4)
        (4.5, 9.0, [116.54, 174.61, 220.00, 261.63, 349.23]),   # Bbmaj9 (Bb2, F3, A3, C4, F4)
        (9.0, 13.5, [98.00, 146.83, 174.61, 220.00, 293.66]),   # Gm9 (G2, D3, F3, A3, D4)
        (13.5, 18.0, [110.00, 164.81, 196.00, 246.94, 293.66]), # A7sus4 -> Dm resolution
    ]

    for start_s, end_s, freqs in chords:
        dur = end_s - start_s
        n = int(dur * SAMPLE_RATE)
        lt = np.linspace(0.0, dur, n, endpoint=False)
        env = np.ones(n)
        atk = int(0.35 * SAMPLE_RATE)
        rel = int(0.45 * SAMPLE_RATE)
        env[:atk] = np.linspace(0.0, 1.0, atk) ** 1.5
        env[-rel:] = np.linspace(1.0, 0.0, rel) ** 1.5

        pad_l = np.zeros(n)
        pad_r = np.zeros(n)
        # Slow LFO filter / amplitude breathing synced to 120 BPM (2 Hz)
        lfo = 0.82 + 0.18 * np.sin(2.0 * np.pi * 2.0 * lt - np.pi / 2.0)

        for i, f in enumerate(freqs):
            detune = 1.0025 if (i % 2 == 0) else 0.9975
            # Soft analog-like wave: fundamental + 0.35 second harmonic + 0.15 third harmonic
            w_l = (
                np.sin(2.0 * np.pi * f * lt)
                + 0.30 * np.sin(2.0 * np.pi * (f * 2.0) * lt + 0.3)
                + 0.12 * np.sin(2.0 * np.pi * (f * 3.0) * lt + 0.7)
            )
            w_r = (
                np.sin(2.0 * np.pi * (f * detune) * lt + 0.4)
                + 0.30 * np.sin(2.0 * np.pi * (f * detune * 2.0) * lt + 0.9)
                + 0.12 * np.sin(2.0 * np.pi * (f * detune * 3.0) * lt + 1.2)
            )
            pan = 0.35 + 0.30 * (i / max(1, len(freqs) - 1))
            pad_l += w_l * (1.0 - pan * 0.4)
            pad_r += w_r * (0.6 + pan * 0.4)

        pad_l = np.tanh(pad_l * 0.32) * env * lfo
        pad_r = np.tanh(pad_r * 0.32) * env * lfo
        add_stereo(pad_l, pad_r, start_s, gain=0.22)

    # 2. Deep Sub-Bass & Kick Pulse on 120 BPM Beat Grid (36 Beats)
    bass_roots = [73.42, 58.27, 49.00, 55.00]  # D2, Bb1, G1, A1
    for beat in range(36):
        b_time = beat * BEAT_SEC
        chord_idx = min(3, int(b_time // 4.5))
        root_f = bass_roots[chord_idx]

        # Kick + Sub envelope (0.45s)
        n_k = int(0.45 * SAMPLE_RATE)
        kt = np.linspace(0.0, 0.45, n_k, endpoint=False)

        # Pitch drop for punchy transient: 135Hz -> root_f in 45ms
        freq_env = root_f + 90.0 * np.exp(-kt * 48.0)
        phase = 2.0 * np.pi * np.cumsum(freq_env) / SAMPLE_RATE
        amp_env = np.exp(-kt * 6.5)
        amp_env[: int(0.004 * SAMPLE_RATE)] = np.linspace(
            0.0, 1.0, int(0.004 * SAMPLE_RATE)
        )

        kick = np.tanh(np.sin(phase) * 1.4) * amp_env

        # Off-beat 8th note driving bass pulse during active scenes (3.5s - 16.5s)
        gain_k = 0.38 if (b_time >= 3.5 or beat in (0, 3)) else 0.26
        add_stereo(kick, kick, b_time, gain=gain_k)

        if 3.5 <= b_time < 16.5:
            n_sub = int(0.22 * SAMPLE_RATE)
            st = np.linspace(0.0, 0.22, n_sub, endpoint=False)
            sub_env = np.exp(-st * 11.0)
            sub_env[:80] = np.linspace(0.0, 1.0, 80)
            sub_wave = (
                np.sin(2.0 * np.pi * root_f * st)
                + 0.45 * np.sin(2.0 * np.pi * (root_f * 2.0) * st)
            ) * sub_env
            add_stereo(sub_wave * 0.9, sub_wave * 1.05, b_time + 0.25, gain=0.20)

    # 3. Crisp 16th-Note Hi-Hat & Subtle Snare/Rim Groove (3.5s - 17.0s)
    total_sixteenths = int(DURATION / 0.125)
    for step in range(total_sixteenths):
        s_time = step * 0.125
        if s_time < 1.5 or s_time > 17.25:
            continue

        n_h = int(0.055 * SAMPLE_RATE)
        ht = np.linspace(0.0, 0.055, n_h, endpoint=False)
        noise = rng.standard_normal(n_h)
        # High-frequency metallic carrier modulation
        metallic = (
            np.sin(2.0 * np.pi * 6400.0 * ht)
            + 0.6 * np.sin(2.0 * np.pi * 9100.0 * ht)
        )
        hat = np.diff(np.concatenate(([0.0], noise * metallic)))
        hat_env = np.exp(-ht * (65.0 if step % 2 == 1 else 45.0))
        hat = hat * hat_env

        vel = 0.055 if (step % 4 == 2) else (0.035 if step % 2 == 0 else 0.022)
        if s_time < 3.5:
            vel *= 0.45
        pan_l = 0.85 if (step % 2 == 0) else 1.15
        pan_r = 1.15 if (step % 2 == 0) else 0.85
        add_stereo(hat * pan_l, hat * pan_r, s_time, gain=vel)

        # Crisp Rim/Snare on Beats 2 and 4 (step % 8 == 4) during Scenes 2 & 3
        if 3.5 <= s_time < 13.5 and (step % 8 == 4):
            n_s = int(0.14 * SAMPLE_RATE)
            st = np.linspace(0.0, 0.14, n_s, endpoint=False)
            body = np.sin(2.0 * np.pi * 210.0 * st) * np.exp(-st * 32.0)
            snap = rng.standard_normal(n_s) * np.exp(-st * 26.0)
            rim = (body * 0.6 + snap * 0.4)
            add_stereo(rim * 0.95, rim * 1.05, s_time, gain=0.14)

    # 4. Mechanical Key-Clicks for "BTC-USD <GO>" Typing (1.82s - 3.02s, 12 chars)
    cmd_chars = "BTC-USD <GO>"
    for idx in range(len(cmd_chars)):
        k_time = 1.82 + idx * 0.095
        n_c = int(0.028 * SAMPLE_RATE)
        ct = np.linspace(0.0, 0.028, n_c, endpoint=False)
        click_Pitch = 1950.0 + (idx % 4) * 180.0
        click = (
            np.sin(2.0 * np.pi * click_Pitch * ct) * np.exp(-ct * 180.0)
            + 0.5 * rng.standard_normal(n_c) * np.exp(-ct * 240.0)
        )
        pan = -0.25 + 0.5 * (idx / len(cmd_chars))
        add_stereo(click * (1.0 - pan), click * (1.0 + pan), k_time, gain=0.18)

    # 5. Harmonic Chimes on Hard Cuts, <GO> Execution & DMA Order Fill
    def add_chime(start_s, freqs, dur_s=0.65, gain=0.18):
        n_c = int(dur_s * SAMPLE_RATE)
        ct = np.linspace(0.0, dur_s, n_c, endpoint=False)
        env = np.exp(-ct * 5.5)
        env[: int(0.005 * SAMPLE_RATE)] = np.linspace(
            0.0, 1.0, int(0.005 * SAMPLE_RATE)
        )
        ch_l = np.zeros(n_c)
        ch_r = np.zeros(n_c)
        for i, f in enumerate(freqs):
            tone = (
                np.sin(2.0 * np.pi * f * ct)
                + 0.25 * np.sin(2.0 * np.pi * (f * 2.0) * ct)
            ) * env
            ch_l += tone * (1.0 if i % 2 == 0 else 0.75)
            ch_r += tone * (0.75 if i % 2 == 0 else 1.0)
        add_stereo(ch_l, ch_r, start_s, gain=gain)

    # Beat 0 (0.0s): Opening ping
    add_chime(0.02, [293.66, 440.00], dur_s=0.7, gain=0.16)
    # Beat 3 (1.5s): Hard cut to "ARGUS RUNS LOCALLY."
    add_chime(1.50, [587.33, 880.00], dur_s=0.55, gain=0.20)
    # t = 3.10s: <GO> Button Press Confirmation
    add_chime(3.10, [587.33, 739.99, 1174.66], dur_s=0.45, gain=0.22)
    # Beat 7 (3.5s): Scene 2 Full Terminal Reveal Shimmer
    add_chime(3.50, [293.66, 349.23, 440.00, 523.25, 659.25], dur_s=0.95, gain=0.18)
    # Beat 17 (8.5s): Scene 3 Engine & Security Cut
    add_chime(8.50, [440.00, 659.25, 880.00], dur_s=0.60, gain=0.18)
    # Beat 20 (10.0s): DMA Market Sweep Order Fill Dual-Tone Chime (A5 -> D6)
    add_chime(10.00, [880.00, 1108.73], dur_s=0.35, gain=0.24)
    add_chime(10.12, [1174.66, 1760.00], dur_s=0.75, gain=0.26)
    # t = 11.25s: Security panel (5 seeded vulnerabilities fixed + regression-tested)
    add_chime(11.25, [698.46, 880.00, 1046.50], dur_s=0.65, gain=0.20)
    # Beat 27 (13.5s): Scene 4 Outro Finale Chord Chime
    add_chime(13.50, [293.66, 440.00, 587.33, 880.00, 1174.66], dur_s=1.6, gain=0.20)

    # Master Fade-In (15ms) and Clean Fade-Out (last 0.55s)
    fade_in = int(0.015 * SAMPLE_RATE)
    fade_out = int(0.55 * SAMPLE_RATE)
    master_env = np.ones(NUM_SAMPLES)
    master_env[:fade_in] = np.linspace(0.0, 1.0, fade_in)
    master_env[-fade_out:] = np.linspace(1.0, 0.0, fade_out) ** 1.6

    left *= master_env
    right *= master_env

    # Soft studio limiter / normalization to -1.0 dBFS peak
    peak = max(np.max(np.abs(left)), np.max(np.abs(right)), 1e-6)
    target_peak = 0.89
    left = np.tanh((left / peak) * 1.15) * target_peak
    right = np.tanh((right / peak) * 1.15) * target_peak

    stereo_pcm = np.empty((NUM_SAMPLES, 2), dtype=np.int16)
    stereo_pcm[:, 0] = np.clip(left * 32767.0, -32768, 32767).astype(np.int16)
    stereo_pcm[:, 1] = np.clip(right * 32767.0, -32768, 32767).astype(np.int16)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(stereo_pcm.tobytes())

    print(f"Generated soundtrack: {out_path} ({ os.path.getsize(out_path) } bytes, {DURATION}s @ {SAMPLE_RATE}Hz Stereo)")


if __name__ == "__main__":
    # Write next to this script (brag-output/work/soundtrack.wav)
    out_wav = os.path.join(os.path.dirname(os.path.abspath(__file__)), "soundtrack.wav")
    generate_soundtrack(out_wav)
