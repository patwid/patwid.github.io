{
  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";
    hugo-theme = {
      url = "github:janraasch/hugo-bearblog";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      hugo-theme,
    }:
    let
      inherit (nixpkgs) lib;
      eachDefaultSystem =
        f:
        lib.systems.flakeExposed
        |> map (s: lib.mapAttrs (_: v: { ${s} = v; }) (f s))
        |> lib.foldAttrs lib.mergeAttrs { };
    in
    eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };
      in
      {
        devShells = {
          default = pkgs.mkShellNoCC {
            buildInputs = with pkgs; [ hugo ];
            shellHook = ''
              mkdir -p themes
              ln -sfT ${hugo-theme} themes/main
            '';
          };
        };

        formatter = pkgs.nixfmt;
      }
    );
}
