FROM nixos/nix

ENV NIX_CONFIG='experimental-features = nix-command flakes pipe-operators'

RUN git config --global --add safe.directory $(pwd)
