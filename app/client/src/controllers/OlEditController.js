import {
  getEditStyle,
  getFeatureHighlightStyle,
  bldEntrancePointsStyle
} from "../style/OlStyleDefs";
import OlBaseController from "./OlBaseController";
import { Modify, Draw, Snap, Translate } from "ol/interaction";
import SnapGuides from "ol-ext/interaction/SnapGuides";
import DrawHole from "ol-ext/interaction/DrawHole";
import VectorSource from "ol/source/Vector";
import VectorLayer from "ol/layer/Vector";
import VectorImageLayer from "ol/layer/VectorImage";
import Overlay from "ol/Overlay.js";
import isochronesStore from "../store/modules/isochrones";
import Feature from "ol/Feature";
import { geojsonToFeature, geometryToWKT } from "../utils/MapUtils";
import http from "../services/http";
import axios from "axios";
import { EventBus } from "../EventBus";
import { unByKey } from "ol/Observable";
import editLayerHelper from "./OlEditLayerHelper";
import i18n from "../../src/plugins/i18n";

/**
 * Class holding the OpenLayers related logic for the edit tool.
 */
export default class OlEditController extends OlBaseController {
  featuresToCommit = [];
  isSnapGuideActive = 0;
  isInteractionOnProgress = false;
  constructor(map) {
    super(map);
  }

  /**
   * Creates the edit vector layer and add it to the
   * map.
   */
  createEditLayer(onFeatureChangeCb, onSourceChangeCb) {
    const me = this;
    const style = getEditStyle();
    super.createLayer("Edit Layer", style, {
      queryable: true
    });
    me.source.on("changefeature", onFeatureChangeCb);
    me.source.on("change", onSourceChangeCb);

    //Create highlight layer
    const highlightSource = new VectorSource({ wrapX: false });
    const highlightLayer = new VectorLayer({
      displayInLayerList: false,
      source: highlightSource,
      zIndex: 10,
      style: getFeatureHighlightStyle()
    });
    me.map.addLayer(highlightLayer);
    me.highlightSource = highlightSource;

    // Layer for storing building entrance features from other scenarios.
    const storageSource = new VectorSource({
      wrapX: false
    });
    const storageOptions = Object.assign(
      {},
      {
        name: "storage_layer",
        displayInLayerList: false,
        source: storageSource,
        queryable: false
      }
    );
    const storageLayer = new VectorLayer(storageOptions);
    me.storageLayer = storageLayer;
  }

  /**
   * Creates the population vector layer and add it to the
   * map.
   */
  createBldEntranceLayer(onFeatureChangeCb, onSourceChangeCb) {
    const me = this;

    // create a vector layer
    const source = new VectorSource({
      wrapX: false
    });
    source.on("changefeature", onFeatureChangeCb);
    source.on("change", onSourceChangeCb);

    const options = Object.assign(
      {},
      {
        name: "Building Entrance Edit Layer",
        displayInLayerList: false,
        zIndex: 100,
        source: source,
        queryable: false,
        style: bldEntrancePointsStyle()
      }
    );
    const vector = new VectorLayer(options);
    me.map.addLayer(vector);
    me.bldEntranceLayer = vector;

    // Layer for storing building entrance features from other scenarios.
    const storageSource = new VectorSource({
      wrapX: false
    });
    const storageOptions = Object.assign(
      {},
      {
        name: "bld_entrance_storage_layer",
        displayInLayerList: false,
        source: storageSource,
        queryable: false
      }
    );
    const storageLayer = new VectorLayer(storageOptions);
    me.bldEntranceStorageLayer = storageLayer;
  }

  /**
   * Creates the edit interaction and adds it to the map.
   */
  addInteraction(editType, startCb, endCb) {
    const me = this;
    // cleanup possible old edit interaction

    me.removeInteraction();
    me.createHelpTooltip();
    me.pointerMoveKey = me.map.on("pointermove", me.onPointerMove.bind(me));
    me.createPopupOverlay();
    switch (editType) {
      case "add": {
        let geometryType = editLayerHelper.selectedLayer.get("editGeometry");
        me.edit = new Draw({
          source: me.source,
          type: geometryType[0]
        });
        me.edit.on("drawstart", startCb);
        me.edit.on("drawend", endCb);
        me.snap = new Snap({ source: me.source });
        me.currentInteraction = "draw";

        me.helpMessage = i18n.t(
          ["Point"].some(r => geometryType.includes(r))
            ? "map.tooltips.clickToPlacePoint"
            : "map.tooltips.clickToStartDrawing"
        );

        if (!["Point", "LineString"].some(r => geometryType.includes(r))) {
          me.isSnapGuideActive = 1;
        } else {
          me.isSnapGuideActive = 0;
        }
        break;
      }
      case "modify": {
        me.edit = new Modify({ source: me.source });
        me.edit.on("modifystart", startCb);
        me.edit.on("modifyend", endCb);
        me.snap = new Snap({ source: me.source });
        me.currentInteraction = "modify";
        me.helpMessage = i18n.t("map.tooltips.clickAndDragToModify");
        break;
      }
      case "addBldEntrance": {
        me.edit = new Draw({
          type: "Point",
          condition: function(evt) {
            // when the point's button is 1(leftclick), allows drawing
            if (evt.pointerEvent.buttons === 1) {
              return true;
            } else {
              return false;
            }
          }
        });
        me.edit.on("drawend", endCb);
        me.modify = new Modify({
          source: me.bldEntranceLayer.getSource()
        });
        me.modify.on("modifyend", endCb);
        me.snap = new Snap({
          source: me.source,
          pixelTolerance: 4
        });
        me.helpMessage = i18n.t("map.tooltips.clickToBldEntrance");
        me.currentInteraction = "addBldEntrance";
        break;
      }
      case "modifyAttributes": {
        me.currentInteraction = "modifyAttributes";
        me.modifyAttributeLister = me.map.on("click", startCb);
        me.helpMessage = i18n.t("map.tooltips.clickToModifyAttributes");
        break;
      }
      case "delete": {
        me.currentInteraction = "delete";
        me.deleteFeatureListener = me.map.on(
          "click",
          me.openDeletePopup.bind(me)
        );
        me.helpMessage = i18n.t("map.tooltips.clickOnFeatureToDelete");
        break;
      }
      case "move": {
        me.currentInteraction = "move";
        me.edit = new Translate({ layers: [me.layer] });
        me.edit.on("translatestart", startCb);
        me.edit.on("translateend", endCb);
        me.helpMessage = i18n.t("map.tooltips.clickOnFeatureToMove");
        break;
      }
      case "drawHole": {
        me.currentInteraction = "drawHole";
        me.edit = new DrawHole({ layers: [me.layer] });
        me.edit.on("modifystart", startCb);
        me.edit.on("modifyend", endCb);
        me.helpMessage = i18n.t("map.tooltips.drawHoleOnPolygon");
        me.isSnapGuideActive = 1;
        break;
      }
      default:
        break;
    }
    if (me.edit) {
      me.map.addInteraction(me.edit);
      if (this.isSnapGuideActive) {
        me.addSnapGuideInteraction();
      }
    }
    if (me.snap) {
      me.map.addInteraction(me.snap);
    }
    if (me.modify) {
      me.map.addInteraction(me.modify);
    }
  }

  /**
   * Method to add the selected features to the edit layer
   */
  addFeatures(features) {
    this.source.addFeatures(features);
  }

  /**
   * Event for updating the edit help tooltip
   */
  onPointerMove(evt) {
    const me = this;
    //Hide helptooltip if mouse is over popoverlay
    if (me.popupOverlay.getPosition() !== undefined) {
      me.helpTooltip.setPosition(undefined);
      return;
    }
    if (me.contextmenu && me.contextmenu.isOpen()) {
      me.helpTooltip.setPosition(undefined);
      return;
    }

    const coordinate = evt.coordinate;
    me.helpTooltipElement.innerHTML = me.helpMessage;
    me.helpTooltip.setPosition(coordinate);
    if (
      ["addBldEntrance", "move", "modify", "drawHole"].includes(
        this.currentInteraction
      )
    ) {
      const featureAtCoord = this.source.getFeaturesAtCoordinate(
        evt.coordinate
      );

      if (
        featureAtCoord.length > 0 &&
        isochronesStore.state.activeScenario &&
        featureAtCoord[0].get("scenario_id") !==
          isochronesStore.state.activeScenario
      ) {
        return;
      }
      if (editLayerHelper.selectedLayer.get("name") === "buildings") {
        if (
          featureAtCoord.length === 0 ||
          (featureAtCoord.length > 0 &&
            !featureAtCoord[0].getProperties().hasOwnProperty("original_id"))
        ) {
          me.map.getTarget().style.cursor = "not-allowed";
          if (me.isInteractionOnProgress === false) {
            me.edit.setActive(false);
          } else {
            return;
          }
          if (this.currentInteraction === "addBldEntrance") {
            me.helpMessage = i18n.t(
              "map.tooltips.clickToBldEntranceNotAllowed"
            );
          }
          if (this.currentInteraction === "move") {
            me.helpMessage = i18n.t(
              "map.tooltips.moveExistingBuildingNotAllowed"
            );
          }
          if (this.currentInteraction === "modify") {
            me.helpMessage = i18n.t(
              "map.tooltips.modifyExistingBuildingNotAllowed"
            );
          }
          if (this.currentInteraction === "drawHole") {
            me.helpMessage = i18n.t("map.tooltips.drawHoleOnPolygonNotAllowed");
          }
        } else {
          if (this.currentInteraction === "addBldEntrance") {
            me.helpMessage = i18n.t("map.tooltips.clickToBldEntrance");
          }
          if (this.currentInteraction === "move") {
            me.helpMessage = i18n.t("map.tooltips.clickOnFeatureToMove");
          }
          if (this.currentInteraction === "modify") {
            me.helpMessage = i18n.t("map.tooltips.clickAndDragToModify");
          }
          if (this.currentInteraction === "drawHole") {
            me.helpMessage = i18n.t("map.tooltips.drawHoleOnPolygon");
          }
          me.map.getTarget().style.cursor = "pointer";
          me.edit.setActive(true);
        }
      }
    }
  }

  /**
   * Opens a popup for the delete confirmation
   */
  openDeletePopup(evt) {
    const me = this;
    let feature;
    if (evt.coordinate) {
      const coordinate = evt.coordinate;
      feature = me.source.getClosestFeatureToCoordinate(coordinate);
    } else {
      //Triggered when user click scenario data table
      //Create overlayer
      me.createPopupOverlay();
      feature = evt;
    }

    me.highlightSource.addFeature(feature);
    me.selectedFeature = feature;
    if (feature) {
      const geometry = feature.getGeometry();
      let popupCoordinate = geometry.getCoordinates();
      while (popupCoordinate && Array.isArray(popupCoordinate[0])) {
        popupCoordinate = popupCoordinate[0];
      }
      me.map.getView().animate({
        center: popupCoordinate,
        duration: 400
      });
      me.popupOverlay.setPosition(popupCoordinate);

      me.popup.title = "confirm";
      me.popup.selectedInteraction = "delete";
      me.popup.isVisible = true;
    }
  }

  /**
   * Delete the feature if user selects yes
   */
  deleteFeature(f) {
    const me = this;
    const selectedFeature = f || me.selectedFeature;
    // If layers selected is building get also all building entrance features of the building and commit a delete request
    if (
      editLayerHelper.selectedLayer.get("name") === "buildings" &&
      this.bldEntranceLayer &&
      selectedFeature
    ) {
      const buildingId =
        selectedFeature.get("gid") ||
        selectedFeature.get("id") ||
        selectedFeature.getId();
      const bldEntranceFeaturesToDelete = this.bldEntranceLayer
        .getSource()
        .getFeatures()
        .filter(
          f =>
            selectedFeature
              .getGeometry()
              .intersectsCoordinate(f.getGeometry().getCoordinates()) &&
            f.get("building_gid") === buildingId
        );
      if (bldEntranceFeaturesToDelete.length > 0) {
        this.deleteBldEntranceFeatures(bldEntranceFeaturesToDelete);
      }
    }

    //Check if feature is from file input (if so, just delete from edit layer)
    // if (me.selectedFeature.get("user_uploaded")) {
    //   me.source.removeFeature(me.selectedFeature);
    // } else {
    editLayerHelper.deleteFeature(
      selectedFeature,
      me.source,
      me.storageLayer.getSource()
    );

    me.closePopup();
  }

  /**
   * Delete Building Entrance Features
   */
  deleteBldEntranceFeatures(features) {
    if (Array.isArray(features)) {
      const deletedBldEntrancePayload = [];
      features.forEach(feature => {
        const gid = feature.getId() || feature.get("gid") || feature.get("id");
        const scenario_id = feature.get("scenario_id");
        if (gid && scenario_id) {
          deletedBldEntrancePayload.push({ gid, scenario_id });
        }
      });
      const payload = {
        table_name: "population_modified",
        mode: "delete",
        features: deletedBldEntrancePayload
      };

      http.post("/api/map/layer_controller", payload);
      features.forEach(feature => {
        this.bldEntranceLayer.getSource().removeFeature(feature);
        if (this.bldEntranceStorageLayer.getSource().hasFeature(feature)) {
          this.bldEntranceStorageLayer.getSource().removeFeature(feature);
        }
      });
    }
  }

  /**
   * Send a request.
   * @param {requestCallback} onUploadCb - The callback that handles the response.
   */
  uploadFeatures(onUploadCb) {
    editLayerHelper.uploadFeatures(this.source, onUploadCb);
  }

  /**
   * Read or insert deleted feature of the user.
   */
  readOrInsertDeletedFeatures() {
    editLayerHelper.commitDelete("read_deleted_features");
  }

  /**
   * Closes the popup if user choose cancel.
   */
  closePopup() {
    const me = this;
    if (me.popupOverlay) {
      me.popupOverlay.setPosition(undefined);
      me.popup.isVisible = false;
    }
    if (me.edit) {
      me.edit.setActive(true);
    }
    me.highlightSource.clear();
  }

  /**
   * Reference popup element
   */
  referencePopupElement(popup) {
    const me = this;
    me.popup = popup;
  }

  /**
   * Transact features to the database
   */
  transact(properties) {
    const me = this;
    const featuresToAdd = [];
    const featuresToUpdate = [];
    const featuresToRemove = [];

    const clonedProperties = Object.assign({}, properties);
    clonedProperties.scenario_id = isochronesStore.state.activeScenario;
    delete clonedProperties["id"];

    const layerName = `${editLayerHelper.selectedLayer.get("name")}_modified`;

    me.featuresToCommit.forEach(feature => {
      const props = feature.getProperties();
      //Transform the feature
      const geometry = feature.getGeometry().clone();
      geometry.transform("EPSG:3857", "EPSG:4326");
      const transformed = new Feature({
        geom: geometry
      });
      //Assign initial attributes
      Object.keys(clonedProperties).forEach(key => {
        let value;
        if (props[key]) {
          value = props[key];
        } else if (clonedProperties[key]) {
          value = clonedProperties[key];
        } else {
          value = null;
        }
        transformed.set(key, value);
      });
      transformed.setGeometryName("geom");

      if (me.currentInteraction === "draw") {
        transformed.setProperties(clonedProperties);
      }

      if (
        !props.hasOwnProperty("original_id") &&
        ["modify", "move", "modifyAttributes", "drawHole"].includes(
          me.currentInteraction
        )
      ) {
        transformed.set(
          "original_id",
          feature.get("id") ? feature.get("id") : null
        );
      }

      if (
        (typeof feature.getId() === "undefined" &&
          Object.keys(props).length === 1) ||
        (!props.hasOwnProperty("original_id") &&
          ["modify", "move", "modifyAttributes", "drawHole"].includes(
            me.currentInteraction
          ))
      ) {
        featuresToAdd.push(transformed);
        featuresToRemove.push(feature);
      } else if (
        props.hasOwnProperty("original_id") &&
        ["modify", "move", "modifyAttributes", "drawHole"].includes(
          me.currentInteraction
        )
      ) {
        transformed.setId(feature.getId());
        featuresToUpdate.push(transformed);
      }
    });
    // ====== PAYLOADS =====
    const payloads = {
      table_name: layerName,
      modes: {
        insert: [],
        update: [],
        delete: []
      }
    };
    // Add features
    featuresToAdd.forEach(feature => {
      const props = feature.getProperties();
      if (props.hasOwnProperty("geom")) {
        delete props.geom;
      }
      if (props.hasOwnProperty("gid")) {
        delete props.gid;
      }
      if (props.hasOwnProperty("id")) {
        delete props.id;
      }
      const wktGeom = geometryToWKT(
        feature.getGeometry(),
        "EPSG:3857",
        "EPSG:4326"
      );
      props.geom = wktGeom;
      payloads.modes.insert.push(props);
    });
    // Update features
    featuresToUpdate.forEach(feature => {
      const props = feature.getProperties();
      if (props.hasOwnProperty("geom")) {
        delete props.geom;
      }
      const wktGeom = geometryToWKT(
        feature.getGeometry(),
        "EPSG:3857",
        "EPSG:4326"
      );
      props.geom = wktGeom;
      props.gid = feature.getId() || feature.get("gid") || feature.get("id");
      payloads.modes.update.push(props);
    });
    // Delete feature
    featuresToRemove.forEach(feature => {
      const gid = feature.getId() || feature.get("gid") || feature.get("id");
      const scenario_id = feature.get("scenario_id");
      if (gid && scenario_id) {
        payloads.modes.delete.push({ gid, scenario_id });
      }
    });
    const promiseArray = [];
    Object.keys(payloads.modes).forEach(mode => {
      if (payloads.modes[mode].length > 0) {
        const payload = {
          table_name: payloads.table_name,
          mode,
          features: payloads.modes[mode]
        };
        promiseArray.push(http.post("/api/map/layer_controller", payload));
      }
    });
    axios.all(promiseArray).then(function(results) {
      results.forEach(response => {
        const payload = JSON.parse(response.config.data);

        if (payload.mode === "insert") {
          const features = geojsonToFeature(response.data, {
            dataProjection: "EPSG:4326",
            featureProjection: "EPSG:3857"
          });
          features.forEach((feature, index) => {
            me.source.removeFeature(featuresToRemove[index]);
            if (
              me.storageLayer.getSource().hasFeature(featuresToRemove[index])
            ) {
              me.storageLayer
                .getSource()
                .removeFeature(featuresToRemove[index]);
            }
            feature.setId(feature.get("gid"));
            me.source.addFeature(feature);
          });
        }

        if (me.currentInteraction == "draw") {
          me.featuresToCommit = [];
        }
        EventBus.$emit("updateAllLayers");
      });
    });
  }

  /**
   * Show popup when user deletes or draws a feature.
   */
  createPopupOverlay() {
    const me = this;
    me.popupOverlay = new Overlay({
      element: me.popup.el.$el,
      autoPan: true,
      autoPanMargin: 40,
      autoPanAnimation: {
        duration: 250
      }
    });
    me.map.addOverlay(me.popupOverlay);
    me.overlayersGarbageCollector.push(me.popupOverlay);
  }

  /**
   * Removes the current edit interaction.
   */
  removeInteraction() {
    const me = this;
    me.featuresToCommit = [];
    me.currentInteraction = "";
    me.removeSnapGuideInteraction();
    me.closePopup();
    if (me.edit) {
      me.map.removeInteraction(me.edit);
      me.edit = null;
    }
    if (me.snap) {
      me.map.removeInteraction(me.snap);
      me.snap = null;
    }
    if (me.modify) {
      me.map.removeInteraction(me.modify);
      me.modify = null;
    }
    if (me.deleteFeatureListener) {
      unByKey(me.deleteFeatureListener);
    }
    if (me.modifyAttributeLister) {
      unByKey(me.modifyAttributeLister);
    }
    if (me.selectedFeature) {
      me.selectedFeature = null;
    }
    if (me.pointerMoveKey) {
      unByKey(me.pointerMoveKey);
    }
    if (me.clearOverlays) {
      me.clearOverlays();
    }
  }

  /**
   * Add snap interaction (aka guide lines) used for building
   */
  addSnapGuideInteraction() {
    // Only for draw and edit
    this.removeSnapGuideInteraction();
    if (
      this.edit &&
      (this.edit instanceof Draw || this.edit instanceof Modify)
    ) {
      const snapi = new SnapGuides({
        vectorClass: VectorImageLayer
      });

      if (this.edit instanceof Draw) {
        snapi.setDrawInteraction(this.edit);
      } else {
        if (
          ["Polygon"].some(r =>
            editLayerHelper.selectedLayer.get("editGeometry").includes(r)
          )
        ) {
          snapi.setModifyInteraction(this.edit);
        }
      }
      this.map.addInteraction(snapi);
      this.snapGuideInteraction = snapi;
    }
  }

  /**
   * Remove snap interaction (aka guide lines) used for building
   */
  removeSnapGuideInteraction() {
    if (this.snapGuideInteraction) {
      this.map.removeInteraction(this.snapGuideInteraction);
    }
  }

  /**
   * Doesnt clear features
   */
  clear() {
    if (this.highlightSource) {
      this.highlightSource.clear();
    }
    if (this.removeInteraction) {
      this.removeInteraction();
    }

    super.clearOverlays();

    this.source.getFeatures().forEach(f => {
      const props = f.getProperties();
      if (!props.hasOwnProperty("layerName")) {
        this.source.removeFeature(f);
        if (this.storageLayer.getSource().hasFeature(f)) {
          this.storageLayer.getSource().removeFeature(f);
        }
      }
      if (
        this.source.hasFeature(f) &&
        !props.hasOwnProperty("original_id") &&
        !props.hasOwnProperty("status")
      ) {
        this.source.removeFeature(f);
        if (this.storageLayer.getSource().hasFeature(f)) {
          this.storageLayer.getSource().removeFeature(f);
        }
      }

      //For uploaded restored features.
      if (
        this.source.hasFeature(f) &&
        props.status === 1 &&
        !props.hasOwnProperty("original_id")
      ) {
        this.source.removeFeature(f);
        if (this.storageLayer.getSource().hasFeature(f)) {
          this.storageLayer.getSource().removeFeature(f);
        }
      }
    });
  }

  /**
   * Delete all user scenario features
   */

  deleteAll() {
    this.clear();
    //Reset ids of deleted features..
    editLayerHelper.featuresIDsToDelete = [];
    editLayerHelper.deletedFeatures = [];
    this.source.getFeatures().forEach(feature => {
      if (
        feature.get("layerName") === editLayerHelper.selectedLayer.get("name")
      ) {
        this.source.removeFeature(feature);
        if (this.storageLayer.getSource().hasFeature(feature)) {
          this.storageLayer.getSource().removeFeature(feature);
        }
      }
    });
    if (
      editLayerHelper.selectedLayer.get("name") === "buildings" &&
      this.bldEntranceLayer
    ) {
      if (this.bldEntranceLayer) {
        this.bldEntranceLayer.getSource().clear();
      }
    }
  }
}
