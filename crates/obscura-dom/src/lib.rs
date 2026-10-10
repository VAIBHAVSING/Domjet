#[macro_use]
extern crate html5ever;

pub mod tree;
pub mod tree_sink;
pub mod selector;
pub mod serialize;

pub use tree::{
    AttachShadowError, Attribute, DomTree, Node, NodeData, NodeId, ShadowRoot,
    ShadowRootMode,
};
pub use tree_sink::{parse_fragment, parse_fragment_with_context, parse_html};

/// Resolve the first document `<base href>` against the fallback document
/// URL. Invalid and script/data base URLs use the document URL; a later base
/// never replaces an invalid first one.
pub fn resolve_document_base_url(tree: &DomTree, document_url: &str) -> Option<url::Url> {
    let document_url = url::Url::parse(document_url).ok()?;
    let base_href = tree
        .query_selector("base[href]")
        .ok()
        .flatten()
        .and_then(|id| {
            tree.get_node(id)
                .and_then(|node| node.get_attribute("href").map(str::to_string))
        });
    let Some(base_href) = base_href else {
        return Some(document_url);
    };
    let Ok(candidate) = document_url.join(&base_href) else {
        return Some(document_url);
    };
    if matches!(candidate.scheme(), "data" | "javascript") {
        Some(document_url)
    } else {
        Some(candidate)
    }
}

#[cfg(test)]
mod base_url_tests {
    use super::*;

    #[test]
    fn first_base_wins_and_invalid_or_forbidden_first_base_falls_back() {
        let document_url = "https://example.test/path/page.html";
        for (html, expected) in [
            ("<main></main>", document_url),
            (
                "<base href='/first/'><base href='https://ignored.test/'>",
                "https://example.test/first/",
            ),
            (
                "<base href='http://['><base href='https://ignored.test/'>",
                document_url,
            ),
            (
                "<base href='data:text/html,no'><base href='https://ignored.test/'>",
                document_url,
            ),
            (
                "<base href='javascript:alert(1)'><base href='https://ignored.test/'>",
                document_url,
            ),
        ] {
            let tree = parse_html(html);
            assert_eq!(
                resolve_document_base_url(&tree, document_url)
                    .unwrap()
                    .as_str(),
                expected,
                "{html}"
            );
        }
    }
}
