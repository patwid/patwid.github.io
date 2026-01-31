FROM nixos/nix

RUN chmod +rw .

ENTRYPOINT ["nix", "develop", "-c", "hugo", "build", "--gc", "--minify"]
CMD ["tail", "-f", "/dev/null"]
