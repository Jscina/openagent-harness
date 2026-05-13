FROM qwen3-coder:30b

# Context: enough to hold explorer + researcher + vision output + the spec
PARAMETER num_ctx 65536

# Sampling: deterministic-ish for code, but not stuck
PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.05

# Generous output budget for multi-file diffs and reviews
PARAMETER num_predict 8192
