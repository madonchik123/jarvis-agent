"""Light fine-tune of the XTTS-v2 GPT on the user's Jarvis clips (fits an 8 GB GPU).

Only the last K transformer blocks + output heads are trained (bf16 autocast, AdamW), validated every epoch with
teacher-forced mel cross-entropy on HELD-OUT real clips; the best weights are kept.

  python ft_xtts.py --out ft_run --epochs 30 --unfreeze 8 --lr 1e-5
"""
import os, sys, json, time, argparse, copy
os.environ['COQUI_TOS_AGREED'] = '1'
import torch
from TTS.config.shared_configs import BaseDatasetConfig
from TTS.tts.datasets import load_tts_samples
from TTS.tts.layers.xtts.trainer.gpt_trainer import GPTArgs, GPTTrainer, GPTTrainerConfig
from TTS.tts.models.xtts import XttsAudioConfig
from TTS.utils.manage import ModelManager

ap = argparse.ArgumentParser()
ap.add_argument('--out', default='ft_run')
ap.add_argument('--epochs', type=int, default=30)
ap.add_argument('--batch', type=int, default=3)
ap.add_argument('--unfreeze', type=int, default=8)
ap.add_argument('--lr', type=float, default=1e-5)
ap.add_argument('--all-data', action='store_true', help='train on every clip (final model); eval clips are still reported')
args = ap.parse_args()

here = os.path.dirname(os.path.abspath(__file__))
ds = os.path.join(here, 'dataset')
out = os.path.join(here, args.out)
os.makedirs(out, exist_ok=True)

meta = json.load(open(os.path.join(ds, 'metadata.json'), encoding='utf8'))
held = [m for i, m in enumerate(meta) if i % 5 == 2 and m['sec'] >= 1.2]
pool = [m for m in meta if m not in held]
train = meta if args.all_data else pool


def csv(path, items):
    with open(path, 'w', encoding='utf8') as f:
        f.write('audio_file|text|speaker_name\n')
        for m in items:
            t = m['text'].strip()
            if t[-1] not in '.!?…': t += '.'
            f.write(f"{m['file']}|{t}|jarvis\n")


csv(os.path.join(ds, 'train.csv'), train)
csv(os.path.join(ds, 'eval.csv'), held)

base = os.path.join(os.environ['LOCALAPPDATA'], 'tts', 'tts_models--multilingual--multi-dataset--xtts_v2')
files = os.path.join(here, 'ft_run', 'base_files'); os.makedirs(files, exist_ok=True)
DVAE = os.path.join(files, 'dvae.pth'); MEL = os.path.join(files, 'mel_stats.pth')
if not (os.path.isfile(DVAE) and os.path.isfile(MEL)):
    ModelManager._download_model_files(['https://huggingface.co/coqui/XTTS-v2/resolve/main/mel_stats.pth', 'https://huggingface.co/coqui/XTTS-v2/resolve/main/dvae.pth'], files, progress_bar=True)

model_args = GPTArgs(
    max_conditioning_length=132300, min_conditioning_length=66150, debug_loading_failures=False, max_wav_length=255995, max_text_length=200,
    mel_norm_file=MEL, dvae_checkpoint=DVAE, xtts_checkpoint=os.path.join(base, 'model.pth'), tokenizer_file=os.path.join(base, 'vocab.json'),
    gpt_num_audio_tokens=1026, gpt_start_audio_token=1024, gpt_stop_audio_token=1025, gpt_use_masking_gt_prompt_approach=True, gpt_use_perceiver_resampler=True)
audio_config = XttsAudioConfig(sample_rate=22050, dvae_sample_rate=22050, output_sample_rate=24000)
config = GPTTrainerConfig(epochs=args.epochs, output_path=out, model_args=model_args, run_name='jarvis_ft', audio=audio_config,
                          batch_size=args.batch, eval_batch_size=args.batch, num_loader_workers=0, num_eval_loader_workers=0, lr=args.lr, test_sentences=[])
dcfg = BaseDatasetConfig(formatter='coqui', dataset_name='jarvis', path=ds, meta_file_train='train.csv', meta_file_val='eval.csv', language='ru')
train_samples, _ = load_tts_samples([dcfg], eval_split=False)
dcfg_e = BaseDatasetConfig(formatter='coqui', dataset_name='jarvis_eval', path=ds, meta_file_train='eval.csv', language='ru')
eval_samples, _ = load_tts_samples([dcfg_e], eval_split=False)
print(f'train {len(train_samples)} clips, eval {len(eval_samples)} clips', flush=True)

dev = 'cuda'
model = GPTTrainer.init_from_config(config).to(dev)
for p in model.parameters(): p.requires_grad = False
gpt = model.xtts.gpt
trainable = []
blocks = gpt.gpt.h
for b in blocks[-args.unfreeze:]: trainable += list(b.parameters())
for name in ('final_norm', 'mel_head', 'text_head'):
    if hasattr(gpt, name): trainable += list(getattr(gpt, name).parameters())
if hasattr(gpt.gpt, 'ln_f'): trainable += list(gpt.gpt.ln_f.parameters())
for p in trainable: p.requires_grad = True
n_tr = sum(p.numel() for p in trainable) / 1e6
print(f'trainable {n_tr:.0f}M params ({args.unfreeze}/{len(blocks)} blocks)', flush=True)

opt = torch.optim.AdamW(trainable, lr=args.lr, betas=(0.9, 0.96), weight_decay=1e-2)
tl = model.get_data_loader(config, None, False, train_samples, False, 1)
el = model.get_data_loader(config, None, True, eval_samples, False, 1)


def to_dev(b):
    return {k: (v.to(dev) if torch.is_tensor(v) else v) for k, v in b.items()}


@torch.no_grad()
def evaluate():
    gpt.eval(); tot = 0; n = 0
    for b in el:
        b = model.format_batch_on_device(to_dev(model.format_batch(b)))
        with torch.autocast('cuda', dtype=torch.bfloat16):
            _, ld = model.eval_step(b, None)
        tot += float(ld['loss_mel_ce']); n += 1
    gpt.train()
    return tot / max(1, n)


best = (evaluate(), 0)
print(f'epoch 0  eval mel-CE {best[0]:.4f}  (pre-trained, zero-shot)', flush=True)
gpt.train(); model.dvae.eval()
t0 = time.time()
for ep in range(1, args.epochs + 1):
    tot = 0; n = 0
    for b in tl:
        b = model.format_batch_on_device(to_dev(model.format_batch(b)))
        with torch.autocast('cuda', dtype=torch.bfloat16):
            _, ld = model.train_step(b, None)
        loss = ld['loss']
        loss.backward()
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        opt.step(); opt.zero_grad(set_to_none=True)
        tot += float(ld['loss_mel_ce']); n += 1
    ev = evaluate()
    mark = ''
    if ev < best[0]:
        best = (ev, ep)
        torch.save({k: v.detach().cpu() for k, v in gpt.state_dict().items()}, os.path.join(out, 'gpt_best.pth'))
        mark = '  <- best'
    if args.all_data and ep == args.epochs:
        torch.save({k: v.detach().cpu() for k, v in gpt.state_dict().items()}, os.path.join(out, 'gpt_final.pth'))
    print(f'epoch {ep:2d}  train mel-CE {tot / max(1, n):.4f}  eval mel-CE {ev:.4f}{mark}   [{time.time() - t0:.0f}s]  mem {torch.cuda.max_memory_allocated() / 1e9:.1f}GB', flush=True)
print('best eval', best, flush=True)
json.dump({'best_eval': best[0], 'best_epoch': best[1], 'unfreeze': args.unfreeze, 'lr': args.lr}, open(os.path.join(out, 'result.json'), 'w'))
