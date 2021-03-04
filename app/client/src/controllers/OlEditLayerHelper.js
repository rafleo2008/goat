import http from "../services/http";
import axios from "axios";
import store from "../store/modules/isochrones";
import { geojsonToFeature } from "../utils/MapUtils";
/**
 * Util class for OL Edit layers.
 */
const CancelToken = axios.CancelToken;
const editLayerHelper = {
  // Cancel Request
  cancelReq: undefined,
  featuresIDsToDelete: [],
  deletedFeatures: [],
  selectedLayer: null,
  selectedWayType: "road",
  filterResults(response, source, bldEntranceLayer, storageSource) {
    const editFeatures = geojsonToFeature(response.first.data, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857"
    });
    const editFeaturesModified = geojsonToFeature(response.second.data, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857"
    });
    source.addFeatures(editFeatures);
    const userInputFeaturesWithOriginId = [];
    const originIdsArr = [];
    const userInputFeaturesNoOriginId = [];

    editFeaturesModified.forEach(feature => {
      const id = parseInt(feature.getId().split(".")[1]);
      feature.setId(id);
      if (feature.getProperties().original_id != null) {
        userInputFeaturesWithOriginId.push(feature);
        originIdsArr.push(feature.getProperties().original_id);
      } else {
        userInputFeaturesNoOriginId.push(feature);
      }
    });

    if (response.third) {
      bldEntranceLayer.getSource().addFeatures(
        geojsonToFeature(response.third.data, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857"
        })
      );
    }

    editFeatures.forEach(feature => {
      let originId;
      const props = feature.getProperties();
      if (props.id) {
        originId = props.id;
      } else if (props.gid) {
        originId = props.gid;
        feature.set("id", props.gid);
      } else if (props.osm_id) {
        originId = props.osm_id;
        feature.set("id", props.osm_id);
      }

      if (
        originIdsArr.includes(originId) ||
        editLayerHelper.featuresIDsToDelete.includes(originId.toString())
      ) {
        //check if feature already exist.
        if (
          editLayerHelper.deletedFeatures.filter(
            f => f.getId() === feature.getId()
          ).length === 0
        ) {
          const clonedFeature = feature.clone();
          const layerName = this.selectedLayer.get("name");
          clonedFeature.set("layerName", layerName);
          clonedFeature.set("deletedId", originId);
          editLayerHelper.deletedFeatures.push(feature.clone());
        }
        source.removeFeature(feature);
        if (storageSource.hasFeature(feature)) {
          storageSource.removeFeature(feature);
        }
      }
    });

    source.addFeatures([
      ...userInputFeaturesWithOriginId,
      ...userInputFeaturesNoOriginId
    ]);
  },
  deleteFeature(feature, source, storageSource) {
    const props = feature.getProperties();
    const beforeStatus = feature.get("status");
    feature.set("status", null);
    feature.set("scenario_id", store.state.activeScenario);
    if (feature.get("layerName") === "pois") {
      feature.set("status", 1);
    }
    if (props.hasOwnProperty("original_id")) {
      if (props.original_id !== null) {
        const fid = feature.getProperties().original_id.toString();
        editLayerHelper.featuresIDsToDelete.push(fid);
        editLayerHelper.deletedFeatures.push(feature);
        editLayerHelper.commitDelete("delete_feature", props.id);
        editLayerHelper.commitDelete("update_deleted_features");
      } else {
        if (beforeStatus !== null) {
          editLayerHelper.deletedFeatures.push(feature);
        }
        editLayerHelper.commitDelete(
          "delete_feature",
          props.id || feature.getId()
        );
      }
    } else {
      let fid;
      if (!props.hasOwnProperty("original_id") && !props.hasOwnProperty("id")) {
        fid = feature.getId().toString();
        editLayerHelper.commitDelete("delete_feature", fid);
      } else {
        fid = feature.getProperties().id.toString();
        editLayerHelper.featuresIDsToDelete.push(fid);
        editLayerHelper.deletedFeatures.push(feature);
        editLayerHelper.commitDelete("update_deleted_features");
      }
    }
    source.removeFeature(feature);
    if (storageSource.hasFeature(feature)) {
      storageSource.removeFeature(feature);
    }
  },
  commitDelete(mode, drawn_fid) {
    const layerName = this.selectedLayer.get("name");
    fetch("/api/map/scenarios", {
      method: "POST",
      body: JSON.stringify({
        mode: mode,
        scenario_id: store.state.activeScenario,
        table_name: layerName,
        deleted_feature_ids: editLayerHelper.featuresIDsToDelete,
        drawned_fid: drawn_fid
      }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    })
      .then(function(data) {
        return data.json();
      })
      .then(function(json) {
        if (mode == "read_deleted_features") {
          editLayerHelper.featuresIDsToDelete = json[0].deleted_feature_ids
            ? json[0].deleted_feature_ids
            : [];
        }
      });
  },

  uploadFeatures(source, onUploadCb) {
    http
      .post(
        "./api/map/upload_all_scenarios",
        {
          scenario_id: parseInt(store.state.activeScenario)
        },
        {
          cancelToken: new CancelToken(function executor(c) {
            // An executor function receives a cancel function as a parameter
            editLayerHelper.cancelReq = c;
          })
        }
      )
      .then(function(response) {
        if (response.status === 200) {
          //Set status of delete features as well
          editLayerHelper.deletedFeatures = editLayerHelper.deletedFeatures.filter(
            feature => {
              if (feature.get("scenario_id") !== store.state.activeScenario) {
                return false;
              }
              feature.setProperties({
                status: 1
              });

              //If there are any user drawn feature remove those.
              if (feature.get("original_id") === null) {
                return false;
              } else {
                return true;
              }
            }
          );
          const bldFeatureIds = [];
          //Update Feature Line type
          source.getFeatures().forEach(feature => {
            if (feature.get("scenario_id") !== store.state.activeScenario) {
              return;
            }
            if (feature.get("layerName") === "buildings") {
              bldFeatureIds.push(feature.getId());
            }
            const prop = feature.getProperties();
            if (
              prop.hasOwnProperty("status") ||
              prop.hasOwnProperty("original_id")
            ) {
              feature.setProperties({
                status: 1
              });
            }
          });

          // Refetch building features  to update the properties (used for population)...

          const buildingsModifiedPayload = {
            mode: "read",
            table_name: `buildings_modified`,
            return_type: "geojson",
            scenario_id: store.state.activeScenario
          };
          http
            .post("/api/map/layer_controller", buildingsModifiedPayload)
            .then(response => {
              if (response.data) {
                const olFeatures = geojsonToFeature(response.data);
                olFeatures.forEach(feature => {
                  if (feature.get("gid")) {
                    const id = parseInt(feature.get("gid"));
                    const editFeature = source.getFeatureById(id);
                    var keys = Object.keys(feature.getProperties());
                    const properties = feature.getProperties();
                    keys.forEach(key => {
                      if (!["geom", "geometry"].includes(key)) {
                        const value = properties[key];
                        if (value) {
                          editFeature.set(key, value);
                        }
                      }
                    });
                  }
                });
              }
            });

          onUploadCb("success");
        }
      })
      .catch(() => {
        onUploadCb("error");
      });
  }
};

export default editLayerHelper;
