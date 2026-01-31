{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    hugo-theme-ananke = {
      url = "github:theNewDynamic/gohugo-theme-ananke";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      hugo-theme-ananke,
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
              ln -s ${hugo-theme-ananke} themes/ananke
            '';
          };
        };

        formatter = pkgs.nixfmt;
      }
    );
}
