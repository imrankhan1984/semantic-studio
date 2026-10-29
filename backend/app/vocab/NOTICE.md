# Bundled vocabularies: sources and licences

Semantic Studio ships these files so that an ontology importing them resolves
with no network connection (`external-access.md` Stage 2, decision D-068).
Each file is unmodified: byte for byte what its source URL served on its
retrieval date (2026-09-27 unless the row says otherwise), pinned by SHA-256
in `manifest.json`. They are used read-only and are never edited or
re-published as Semantic Studio's own.

| Vocabulary | File | Source | Licence | Copyright |
| --- | --- | --- | --- | --- |
| SKOS | `skos.rdf` | https://www.w3.org/2009/08/skos-reference/skos.rdf | [W3C Document License](https://www.w3.org/copyright/document-license/) | © World Wide Web Consortium |
| DCMI Metadata Terms | `dcterms.ttl` | https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | © Dublin Core Metadata Initiative |
| Dublin Core Elements 1.1 | `dcelements.ttl` | https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_elements.ttl | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | © Dublin Core Metadata Initiative |
| FOAF | `foaf.rdf` | https://xmlns.com/foaf/spec/index.rdf | [CC BY 1.0](https://creativecommons.org/licenses/by/1.0/) | Dan Brickley and Libby Miller |
| DCAT 3 | `dcat3.ttl` | https://www.w3.org/ns/dcat3.ttl | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (stated in the file) | © World Wide Web Consortium |
| PROV-O | `prov-o.ttl` | https://www.w3.org/ns/prov-o.ttl | [W3C Document License](https://www.w3.org/copyright/document-license/) | © World Wide Web Consortium |
| ORG | `org.ttl` | https://www.w3.org/ns/org.ttl | [ODC PDDL 1.0](http://www.opendatacommons.org/licenses/pddl/1.0/) (stated in the file) | © World Wide Web Consortium |
| OWL-Time | `time.ttl` | https://www.w3.org/2006/time.ttl | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (stated in the file) | © 2006-2017 W3C, OGC |
| SHACL | `shacl.ttl` | https://www.w3.org/ns/shacl.ttl | [W3C Document License](https://www.w3.org/copyright/document-license/) | © World Wide Web Consortium |
| vCard Ontology | `vcard.ttl` | https://www.w3.org/2006/vcard/ns.ttl | [W3C Document License](https://www.w3.org/copyright/document-license/) | © World Wide Web Consortium |
| BFO 2020 | `bfo-2020.ttl` | https://raw.githubusercontent.com/BFO-ontology/BFO-2020/master/21838-2/owl/bfo-core.ttl | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (stated in the file) | BFO 2020 authors |
| QUDT 3.5.2 | `qudt-3.5.2.ttl` | https://qudt.org/3.5.2/qudt-all (retrieved 2026-10-29) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (stated in the file); UCUM codes under the [UCUM license](https://ucum.org/license) | Attribution: QUDT.org |

None of the eleven proposed vocabularies was dropped: every licence above
permits redistribution of the unmodified file with attribution, which this
notice provides.

QUDT was added on 2026-10-29 (reference-ontologies 5.1), unmodified, as a
reference ontology for the library and an offline import. Beside its CC BY 4.0
statement the file carries a second rights statement, repeated here as its
licence asks:

> This product includes all or a portion of the UCUM table, UCUM codes, and
> UCUM definitions or is derived from it, subject to a license from Regenstrief
> Institute, Inc. and The UCUM Organization. Your use of the UCUM table, UCUM
> codes, UCUM definitions also is subject to this license, a copy of which is
> available at http://unitsofmeasure.org. The UCUM table and UCUM codes are
> copyright © 1995-2009, Regenstrief Institute, Inc. and the Unified Codes for
> Units of Measures (UCUM) Organization. All rights reserved.
>
> THE UCUM TABLE (IN ALL FORMATS), UCUM DEFINITIONS, AND SPECIFICATION ARE
> PROVIDED 'AS IS.' ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED,
> INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS FOR A PARTICULAR PURPOSE.

The UCUM codes are shipped exactly as QUDT publishes them and never edited.
