"""Small, dependency-free logistic regression training recipe for execution verification."""
import argparse
import json
import math
import os
from pathlib import Path
import random
import time
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate import accuracy as evaluate_accuracy

parser = argparse.ArgumentParser()
parser.add_argument('--hold-seconds', type=float, default=0)
args = parser.parse_args()
random.seed(41)
samples = [(random.uniform(-2, 2), random.uniform(-2, 2)) for _ in range(800)]
labels = [int(x + 0.7 * y > 0.15) for x, y in samples]
train, validation = list(zip(samples[:600], labels[:600])), list(zip(samples[600:], labels[600:]))
weights = [0.0, 0.0, 0.0]
out = Path(os.environ['TRAINERBUDDY_OUTPUT_DIR'])
metrics_path = Path(os.environ['TRAINERBUDDY_METRICS_FILE'])
run_id = os.environ['TRAINERBUDDY_RUN_ID']
print(json.dumps({'seed': 41, 'train_size': len(train), 'validation_size': len(validation), 'epochs': 80, 'learning_rate': 0.2}), flush=True)

def probability(x, y):
    return 1 / (1 + math.exp(-(weights[0] * x + weights[1] * y + weights[2])))

with metrics_path.open('w', encoding='utf-8') as metrics:
    for epoch in range(80):
        gradient = [0.0, 0.0, 0.0]
        loss = 0.0
        for (x, y), target in train:
            p = probability(x, y)
            error = p - target
            gradient[0] += error * x
            gradient[1] += error * y
            gradient[2] += error
            loss -= target * math.log(max(p, 1e-12)) + (1-target) * math.log(max(1-p, 1e-12))
        weights = [w - 0.2 * g / len(train) for w, g in zip(weights, gradient)]
        record = {'schema_version': 1, 'run_id': run_id, 'stage': 'train', 'metric': 'loss', 'step': epoch, 'value': loss / len(train)}
        metrics.write(json.dumps(record) + '\n')
        metrics.flush()
        if epoch % 20 == 0:
            print(json.dumps(record), flush=True)
    accuracy = evaluate_accuracy(probability, validation)
    final = {'schema_version': 1, 'run_id': run_id, 'stage': 'evaluate', 'metric': 'validation_accuracy', 'step': 80, 'value': accuracy}
    final['evaluation_hash'] = os.environ.get('TRAINERBUDDY_EVALUATION_HASH', '')
    metrics.write(json.dumps(final) + '\n')
    print(json.dumps(final), flush=True)
out.joinpath('model.json').write_text(json.dumps({'weights': weights, 'seed': 41, 'validation_accuracy': accuracy}), encoding='utf-8')
out.joinpath('report.md').write_text(f'# CPU classifier\n\nRun: {run_id}\n\nValidation accuracy: {accuracy}\n\nSynthetic data; this verifies training execution, not language-model quality.\n', encoding='utf-8')
time.sleep(args.hold_seconds)
