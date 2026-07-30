//! Vault filesystem access. All filesystem and clock access in this crate
//! goes through traits so reconciliation logic is testable under a seeded
//! deterministic simulator; direct `std::fs` use is confined to the store
//! implementation.

#[cfg(test)]
mod tests {
    #[test]
    fn crate_builds() {}
}
