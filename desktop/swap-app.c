#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    // Keep the installed path valid even if the process is interrupted.
    if (renamex_np(argv[1], argv[2], RENAME_SWAP) != 0) {
        perror("Could not exchange Mandala bundles");
        return 1;
    }
    return 0;
}
