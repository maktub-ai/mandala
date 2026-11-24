// Offline verification tool only. Not bundled, and no execute/install operation.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <wintrust.h>
#include <softpub.h>
#include <array>
#include <cstdint>
#include <cwctype>
#include <utility>
#include <regex>
#include <string>
#include <vector>

namespace {
enum Result { verified = 0, bad_arguments = 10, bad_path = 11, bad_size = 12, bad_digest = 13,
              untrusted = 20, bad_signer = 21, bad_pin = 22, unavailable = 23 };
struct File {
  HANDLE handle;
  explicit File(HANDLE value) : handle(value) {}
  File(File const&) = delete;
  File(File&& other) noexcept : handle(other.handle) { other.handle = INVALID_HANDLE_VALUE; }
  ~File() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
};
struct Module {
  HMODULE value = LoadLibraryExW(L"wintrust.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  ~Module() { if (value) FreeLibrary(value); }
};
struct Hash {
  BCRYPT_ALG_HANDLE algorithm{};
  BCRYPT_HASH_HANDLE hash{};
  Hash() {
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) throw unavailable;
    if (BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) != 0) {
      BCryptCloseAlgorithmProvider(algorithm, 0); throw unavailable;
    }
  }
  ~Hash() { BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0); }
  void add(const unsigned char* data, DWORD size) {
    if (BCryptHashData(hash, const_cast<unsigned char*>(data), size, 0) != 0) throw unavailable;
  }
  std::wstring finish() {
    std::array<unsigned char,32> out{};
    if (BCryptFinishHash(hash, out.data(), static_cast<ULONG>(out.size()), 0) != 0) throw unavailable;
    std::wstring result;
    for (auto b : out) {
      result += L"0123456789abcdef"[b >> 4]; result += L"0123456789abcdef"[b & 15];
    }
    return result;
  }
};

bool exactHex(const std::wstring& value) {
  return value.size() == 64 && value.find_first_not_of(L"0123456789abcdef") == std::wstring::npos;
}
bool noReparse(HANDLE file, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  return GetFileInformationByHandleEx(file, FileAttributeTagInfo, &info, sizeof(info)) &&
    !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
    !!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory;
}

std::vector<File> lockParents(const std::wstring& path) {
  if (path.size() < 4 || path.size() >= 900 || !iswalpha(path[0]) || path[1] != L':' || path[2] != L'\\' ||
      path.find_first_of(L"/:*?\"<>|", 2) != std::wstring::npos ||
      GetDriveTypeW(path.substr(0, 3).c_str()) != DRIVE_FIXED) throw bad_path;
  std::array<wchar_t, 1024> full{};
  auto n = GetFullPathNameW(path.c_str(), static_cast<DWORD>(full.size()), full.data(), nullptr);
  if (!n || n >= full.size() || path != full.data()) throw bad_path;
  auto lastSlash = path.find_last_of(L'\\');
  if (!std::regex_match(path.substr(lastSlash + 1),
      std::wregex(L"Mandala-(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})-win-x64\\.exe"))) throw bad_path;
  std::vector<File> held;
  for (size_t i = path.find(L'\\', 3); i != std::wstring::npos; i = path.find(L'\\', i + 1)) {
    // Refuse directory renames during verification; allow other readers/writers in the directory.
    File dir(CreateFileW(path.substr(0, i).c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (dir.handle == INVALID_HANDLE_VALUE || !noReparse(dir.handle, true)) throw bad_path;
    held.push_back(std::move(dir));
  }
  return held;
}

std::wstring digestFile(HANDLE file, std::uint64_t expected) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 ||
      static_cast<std::uint64_t>(size.QuadPart) != expected) throw bad_size;
  Hash hash;
  std::array<unsigned char, 64 * 1024> buffer{};
  std::uint64_t total = 0;
  while (true) {
    DWORD read = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) throw unavailable;
    if (!read) {
      if (total != expected) throw bad_size;
      return hash.finish();
    }
    total += read;
    if (total > expected) throw bad_size;
    hash.add(buffer.data(), read);
  }
}

void verifyEmbedded(HANDLE handle, std::wstring const& path, std::wstring const& pin) {
  Module module;
  if (!module.value) throw unavailable;
  const auto verify = reinterpret_cast<decltype(&WinVerifyTrust)>(GetProcAddress(module.value, "WinVerifyTrust"));
  const auto prov = reinterpret_cast<decltype(&WTHelperProvDataFromStateData)>(GetProcAddress(module.value, "WTHelperProvDataFromStateData"));
  const auto getSigner = reinterpret_cast<decltype(&WTHelperGetProvSignerFromChain)>(GetProcAddress(module.value, "WTHelperGetProvSignerFromChain"));
  if (!verify || !prov || !getSigner) throw unavailable;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  WINTRUST_FILE_INFO file{};
  file.cbStruct = sizeof(file);
  file.pcwszFilePath = path.c_str();
  file.hFile = handle;
  WINTRUST_SIGNATURE_SETTINGS signatures{};
  signatures.cbStruct = sizeof(signatures);
  signatures.dwFlags = WSS_VERIFY_SPECIFIC | WSS_GET_SECONDARY_SIG_COUNT;
  signatures.cSecondarySigs = MAXDWORD;
  signatures.dwVerifiedSigIndex = MAXDWORD;
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN;
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &file;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_DISABLE_MD2_MD4;
  data.pSignatureSettings = &signatures;
  const auto result = verify(nullptr, &action, &data);
  const auto close = [&]() { data.dwStateAction = WTD_STATEACTION_CLOSE; verify(nullptr, &action, &data); };
  try {
    if (result != ERROR_SUCCESS) throw untrusted;
    if (signatures.dwVerifiedSigIndex != 0 || signatures.cSecondarySigs != 0) throw bad_signer;
    // Only an embedded PKCS#7 can qualify; do not accept an OS catalog member.
    if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, path.c_str(), CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
        CERT_QUERY_FORMAT_FLAG_BINARY, 0, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr)) throw bad_signer;
    const auto state = prov(data.hWVTStateData);
    if (!state || state->csSigners != 1 || state->dwSubjectChoice != CPD_CHOICE_SIP) throw bad_signer;
    const auto signer = getSigner(state, 0, FALSE, 0);
    if (!signer || signer->dwError || !signer->pChainContext || signer->pChainContext->TrustStatus.dwErrorStatus || !signer->csCertChain || !signer->pasCertChain ||
        !signer->pasCertChain[0].pCert) throw bad_signer;
    auto& spki = signer->pasCertChain[0].pCert->pCertInfo->SubjectPublicKeyInfo;
    DWORD size = 0;
    if (!CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, &spki, 0, nullptr, nullptr, &size) ||
        !size || size > 64 * 1024) throw unavailable;
    std::vector<unsigned char> der(size);
    if (!CryptEncodeObjectEx(X509_ASN_ENCODING, X509_PUBLIC_KEY_INFO, &spki, 0, nullptr, der.data(), &size)) throw unavailable;
    Hash hash;
    hash.add(der.data(), size);
    if (hash.finish() != pin) throw bad_pin;
  } catch (...) { close(); throw; }
  close();
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 5) return bad_arguments;
    const std::wstring path = argv[1], sizeText = argv[2], digest = argv[3], pin = argv[4];
    if (sizeText.empty() || sizeText.size() > 10 || sizeText[0] == L'0' ||
        sizeText.find_first_not_of(L"0123456789") != std::wstring::npos || !exactHex(digest) || !exactHex(pin)) return bad_arguments;
    const auto size = std::stoull(sizeText);
    if (size > 2ULL * 1024 * 1024 * 1024) return bad_arguments;
    const auto parents = lockParents(path);
    File file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
    if (file.handle == INVALID_HANDLE_VALUE || GetFileType(file.handle) != FILE_TYPE_DISK ||
        !noReparse(file.handle, false)) return bad_path;
    std::array<wchar_t, 1024> resolved{};
    const auto n = GetFinalPathNameByHandleW(file.handle, resolved.data(), static_cast<DWORD>(resolved.size()), FILE_NAME_NORMALIZED);
    if (!n || n >= resolved.size() || CompareStringOrdinal((L"\\\\?\\"+path).c_str(), -1, resolved.data(), -1, TRUE) != CSTR_EQUAL) return bad_path;
    if (digestFile(file.handle, size) != digest) return bad_digest;
    LARGE_INTEGER zero{};
    if (!SetFilePointerEx(file.handle, zero, nullptr, FILE_BEGIN)) return unavailable;
    verifyEmbedded(file.handle, path, pin);
    return verified;
  } catch (Result result) { return result; } catch (...) { return unavailable; }
}
