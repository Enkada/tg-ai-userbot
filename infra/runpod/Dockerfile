# Published worker 5.10.0-base-cuda12.8.1, pinned so rebuilds cannot silently change it.
# Build with a dedicated context containing only this file and the two model files.
FROM runpod/worker-comfyui@sha256:45a1abd8796dbbcbc631f3d7d0db942946ce2f82ff24a070e3e6c527eeff9c47

# Keep weights on the worker's local disk to allow placement in any data center.
COPY models/checkpoints/waiIllustriousSDXL_v160.safetensors /comfyui/models/checkpoints/waiIllustriousSDXL_v160.safetensors
COPY models/loras/ramdomrot_v2_illustrious_locon-000009.safetensors /comfyui/models/loras/ramdomrot_v2_illustrious_locon-000009.safetensors

ENV COMFY_LOG_LEVEL=INFO
